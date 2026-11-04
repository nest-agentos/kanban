import {randomUUID, sha256HexSync} from './utils';
import type {KanbanItem, KanbanProjectRecord} from './contracts';
import {summary} from './planning';
import {recordSummary} from './project-records';
import {KanbanError, type KanbanReadView, type KanbanState} from './ports';
import {requireValue} from './rules';

export interface KanbanBodyStore {
    read(sha256: string): Promise<ArrayBuffer | null>;
    write(sha256: string, bytes: ArrayBuffer): Promise<void>;
}
interface Manifest {itemIndex: KanbanReadView['items']; recordIndex: KanbanReadView['records']; layout: 2; generation: string; state: KanbanState; itemIds: string[]; recordIds: string[]}
interface BodyRef {body: 'kanban-body/v1'; sha256: string; bytes: number}
export interface StoredBoard {raw: string | null; rows: Record<string, string>}
export const boardKey = (id: string): string => `board/${encodeURIComponent(id)}`;
export const archiveKey = (board: string, item: string): string => `archive/${encodeURIComponent(board)}/${encodeURIComponent(item)}`;
const rowKey = (kind: 'item' | 'record', board: string, id: string): string => `${kind}/${encodeURIComponent(board)}/${encodeURIComponent(id)}`;

export function rowKeys(raw: string | null): string[] {
    if (raw === null) return [];
    const saved = JSON.parse(raw) as Manifest;
    if (saved.layout !== 2) return [];
    requireValue(Array.isArray(saved.itemIds) && Array.isArray(saved.recordIds) && saved.state?.board, 'INVALID_STORAGE');
    return [...saved.itemIds.map(id => rowKey('item', saved.state.board.id, id)), ...saved.recordIds.map(id => rowKey('record', saved.state.board.id, id))];
}
export async function hydrate(saved: StoredBoard, bodies?: KanbanBodyStore): Promise<KanbanState | null> {
    if (saved.raw === null) return null;
    const parsed = JSON.parse(saved.raw) as Manifest;
    if (parsed.layout !== 2) return validateState(parsed as unknown as KanbanState);
    const state = validateState(parsed.state), id = state.board.id;
    state.board.items = await Promise.all(parsed.itemIds.map(async itemId => {
        const item = await decodeRow<KanbanItem>(requiredRow(saved, rowKey('item', id, itemId)), bodies);
        requireValue(item.id === itemId, 'INVALID_STORAGE'); return item;
    }));
    state.records = await Promise.all(parsed.recordIds.map(async recordId => {
        const record = await decodeRow<KanbanProjectRecord>(requiredRow(saved, rowKey('record', id, recordId)), bodies);
        requireValue(record.id === recordId, 'INVALID_STORAGE'); return record;
    }));
    return state;
}
export async function encodeBoard(state: KanbanState, bodies?: KanbanBodyStore): Promise<StoredBoard> {
    const rows: Record<string, string> = {}, id = state.board.id;
    for (const item of state.board.items) rows[rowKey('item', id, item.id)] = await encodeRow(item, bodies);
    for (const record of state.records ?? []) rows[rowKey('record', id, record.id)] = await encodeRow(record, bodies);
    const manifest: Manifest = {itemIndex: state.board.items.map(summary), recordIndex: (state.records ?? []).map(recordSummary), layout: 2, generation: randomUUID(), state: {...state, board: {...state.board, items: []}, records: []},
        itemIds: state.board.items.map(item => item.id), recordIds: (state.records ?? []).map(record => record.id)};
    return {raw: JSON.stringify(manifest), rows};
}
export function rowChanges(before: StoredBoard, after: StoredBoard): Array<{key: string; value: string | null}> {
    const writes = Object.entries(after.rows).filter(([key, value]) => before.rows[key] !== value).map(([key, value]) => ({key, value: value as string | null}));
    for (const key of Object.keys(before.rows)) if (!(key in after.rows)) writes.push({key, value: null});
    return writes;
}
export function receiptDigest(fingerprint: string): string {return `sha256:v1:${sha256HexSync(fingerprint)}`;}
export function verifyReceipt(saved: string, fingerprint: string): void {
    requireValue(saved === fingerprint || saved === receiptDigest(fingerprint), 'IDEMPOTENCY_CONFLICT');
}
export async function encodeRow(value: unknown, bodies?: KanbanBodyStore): Promise<string> {
    const raw = JSON.stringify(value), bytes = new TextEncoder().encode(raw);
    if (!bodies || bytes.length <= 8192) return raw;
    const ref: BodyRef = {body: 'kanban-body/v1', sha256: sha256HexSync(bytes), bytes: bytes.length};
    // Body publication precedes the referencing transaction; unreferenced files are retained.
    const existing = await bodies.read(ref.sha256);
    if (existing !== null) verifyBody(existing, ref);
    else {
        let failure: unknown;
        try {await bodies.write(ref.sha256, bytes.buffer);} catch (error) {failure = error;}
        const confirmed = await bodies.read(ref.sha256);
        if (confirmed === null) throw failure ?? new KanbanError('BODY_WRITE_UNCONFIRMED');
        verifyBody(confirmed, ref);
    }
    return JSON.stringify(ref);
}
export async function decodeRow<T>(raw: string, bodies?: KanbanBodyStore): Promise<T> {
    const parsed = JSON.parse(raw) as BodyRef;
    if (parsed?.body !== 'kanban-body/v1') return parsed as T;
    requireValue(/^[a-f0-9]{64}$/.test(parsed.sha256) && Number.isSafeInteger(parsed.bytes) && parsed.bytes > 8192, 'INVALID_BODY_REFERENCE');
    requireValue(bodies, 'BODY_STORE_REQUIRED'); const bytes = await bodies.read(parsed.sha256);
    requireValue(bytes !== null, 'BODY_MISSING'); verifyBody(bytes, parsed);
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as T;
}
function verifyBody(bytes: ArrayBuffer, ref: BodyRef): void {
    requireValue(bytes instanceof ArrayBuffer && bytes.byteLength === ref.bytes && sha256HexSync(bytes) === ref.sha256, 'BODY_INTEGRITY');
}
function requiredRow(saved: StoredBoard, key: string): string {requireValue(typeof saved.rows[key] === 'string', 'MISSING_STORAGE_ROW'); return saved.rows[key];}
function validateState(state: KanbanState): KanbanState {
    requireValue(state?.schema === 1 && state.board && Array.isArray(state.board.items) && Array.isArray(state.events), 'INVALID_STORAGE'); return state;
}

export function indexedView(raw: string | null): KanbanReadView | null {
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Manifest;
    if (parsed.layout === 2 && Array.isArray(parsed.itemIndex) && Array.isArray(parsed.recordIndex))
        return {state: validateState(parsed.state), items: parsed.itemIndex, records: parsed.recordIndex};
    return null;
}
export function viewFromState(state: KanbanState): KanbanReadView {
    return {state: {...state, board: {...state.board, items: []}, records: []}, items: state.board.items.map(summary), records: (state.records ?? []).map(recordSummary)};
}
