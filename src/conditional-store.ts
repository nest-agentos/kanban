import {numberEntities, boardCounterKey, boardNumberKey, counter, allocateBoardNumber, storedBoardNumber} from './numbering';
import type {KanbanSeqClient, KanbanSeqChange, KanbanSeqSnapshot} from './storage-ports';
import type {KanbanEvent, KanbanArchivedItem} from './contracts';
import {KanbanError, type KanbanState, type KanbanStore} from './ports';
import {requireValue} from './rules';
import {indexedView, viewFromState, archiveKey, boardKey as key, rowKeys, hydrate, encodeBoard, rowChanges, encodeRow, decodeRow, receiptDigest, verifyReceipt, type StoredBoard, type KanbanBodyStore} from './storage-codec';

/** The project export and its authorization are frozen in the injected HTTP client. */
export class ConditionalKanbanStore implements KanbanStore {
    constructor(private readonly client: Pick<KanbanSeqClient, 'query' | 'transaction'> & Partial<Pick<KanbanSeqClient, 'readBody' | 'writeBody'>>,
        private readonly prepareDirectory: () => Promise<void>, private readonly path = 'kanban/boards.seq', private readonly bodies?: KanbanBodyStore) {
        if (!bodies && client.readBody && client.writeBody) this.bodies = {read: async hash => {
            try {return await client.readBody!(path, hash);}
            catch (error) {if ((error as {remoteCode?: string})?.remoteCode === 'SEQ_BODY_INTEGRITY') throw new KanbanError('BODY_INTEGRITY'); throw error;}
        }, write: (hash, bytes) => client.writeBody!(path, hash, bytes)};
    }
    private async select(keys: string[]): Promise<KanbanSeqSnapshot> {return this.client.query(this.path, {keys});}
    async boardId(number: number): Promise<string | null> {return entry(await this.select([boardNumberKey(number)]), boardNumberKey(number));}
    async ids(): Promise<string[]> {return JSON.parse(entry(await this.select(['index']), 'index') ?? '[]');}
    async view(id: string) {
        const raw = entry(await this.select([key(id)]), key(id));
        const indexed = indexedView(raw); if (indexed) return indexed;
        const state = await this.read(id); return state ? viewFromState(state) : null;
    }
    async read(id: string): Promise<KanbanState | null> {
        const snapshot = await this.select([key(id)]);
        return hydrate(await this.loadRows(entry(snapshot, key(id)), snapshot.revision), this.bodies);
    }
    private async loadRows(raw: string | null, revision: string | null): Promise<StoredBoard> {
        const keys = rowKeys(raw), rows: Record<string, string> = {};
        for (let start = 0; start < keys.length; start += 256) {
            requireValue(revision !== null, 'INVALID_STORAGE');
            const page = await this.queryRevision(keys.slice(start, start + 256), revision);
            for (const row of page.entries) {requireValue(typeof row.value === 'string', 'INVALID_STORAGE'); rows[row.key] = row.value;}
        }
        return {raw, rows};
    }
    private async queryRevision(keys: string[], expectedRevision: string) {
        try {return await this.client.query(this.path, {keys, expectedRevision});}
        catch (error) {
            if ((error as {code?: string})?.code === 'ECONFLICT') throw new KanbanError('REVISION_CONFLICT');
            throw error;
        }
    }
    async events(id: string, after: number, limit: number, through: number): Promise<KanbanEvent[]> {
        const end = Math.min(through, after + limit);
        const keys = Array.from({length: Math.max(0, end - after)}, (_, index) =>
            `event/${encodeURIComponent(id)}/${String(after + index + 1).padStart(16, '0')}`);
        if (!keys.length) return [];
        const events: KanbanEvent[] = [];
        // Event keys below through are immutable; concurrent appends cannot change this prefix.
        for (let start = 0; start < keys.length; start += 256) {
            const rows = await this.select(keys.slice(start, start + 256));
            events.push(...rows.entries.map(e => JSON.parse(String(e.value)) as KanbanEvent));
        }
        return events.sort((a, b) => a.sequence - b.sequence);
    }
    async archived(board: string, item: string): Promise<KanbanArchivedItem | null> {
        const raw = entry(await this.select([archiveKey(board, item)]), archiveKey(board, item));
        if (!raw) return null; const record = await decodeRow<KanbanArchivedItem>(raw, this.bodies);
        record.item.number ??= (await this.view(board))?.state.archiveIndex?.find(value => value.id === item)?.number; return record;
    }
    private async numberBoard(snapshot: KanbanSeqSnapshot, raw: string | null, id: string, state: KanbanState): Promise<KanbanSeqChange[]> {
        const high = counter(entry(snapshot, boardCounterKey)), number = allocateBoardNumber(raw, high);
        state.board.number = number;
        if (storedBoardNumber(raw) !== undefined) return [];
        if (snapshot.revision !== null) {
            const lookup = await this.queryRevision([boardNumberKey(number)], snapshot.revision), owner = entry(lookup, boardNumberKey(number));
            requireValue(owner === null || owner === id, 'INVALID_NUMBERING');
        }
        return [{action:'set',key:boardCounterKey,value:String(Math.max(high,number))}, {action:'set',key:boardNumberKey(number),value:id}];
    }
    async update(id: string, operationId: string, fingerprint: string,
        change: (state: KanbanState | null) => KanbanState): Promise<KanbanState> {
        await this.prepareDirectory();
        const receiptKey = `receipt/${encodeURIComponent(id)}/${encodeURIComponent(operationId)}`;
        const snapshot = await this.select([key(id), receiptKey, 'index', boardCounterKey]);
        const raw = entry(snapshot, key(id)), receipt = entry(snapshot, receiptKey);
        const before = await this.loadRows(raw, snapshot.revision), current = await hydrate(before, this.bodies);
        if (receipt) {verifyReceipt(receipt, fingerprint); requireValue(current, 'CORRUPT_RECEIPT'); return current;}
        const original = JSON.stringify(current), state = change(current); numberEntities(state); if (JSON.stringify(state) === original) return state;
        const numbering = await this.numberBoard(snapshot, raw, id, state);
        const {changes, encoded} = await prepareChanges(id, before, state, this.bodies);
        changes.push(...numbering);
        changes.push({action: 'set', key: key(id), value: encoded.raw!}, {action: 'set', key: receiptKey, value: receiptDigest(fingerprint)});
        const ids: string[] = JSON.parse(entry(snapshot, 'index') ?? '[]');
        if (!ids.includes(id)) changes.push({action: 'set', key: 'index', value: JSON.stringify([...ids, id])});
        requireValue(changes.length <= 256, 'REMOTE_TRANSACTION_LIMIT');
        // The transport owns unknown-write reconciliation. Never retry a mutation here.
        try {await this.client.transaction(this.path, snapshot.revision, changes);}
        catch (error) {
            if ((error as {outcome?: string})?.outcome === 'not-committed' && (error as {code?: string})?.code === 'ECONFLICT') throw new KanbanError('REVISION_CONFLICT');
            throw error;
        }
        return state;
    }
}
function entry(snapshot: KanbanSeqSnapshot, key: string): string | null {
    const value = snapshot.entries.find(e => e.key === key)?.value;
    if (value === undefined) return null;
    if (typeof value !== 'string') throw new KanbanError('INVALID_STORAGE'); return value;
}

async function prepareChanges(id: string, before: StoredBoard, state: KanbanState, bodies?: KanbanBodyStore) {
    const changes: KanbanSeqChange[] = state.events.map(event => ({action: 'set',
        key: `event/${encodeURIComponent(id)}/${String(event.sequence).padStart(16, '0')}`, value: JSON.stringify(event)}));
    for (const write of state.archiveWrites ?? []) changes.push(write.value
        ? {action: 'set', key: archiveKey(id, write.id), value: await encodeRow(write.value, bodies)}
        : {action: 'delete', key: archiveKey(id, write.id)});
    delete state.archiveWrites; state.events = [];
    const encoded = await encodeBoard(state, bodies);
    for (const row of rowChanges(before, encoded)) changes.push(row.value === null ? {action: 'delete', key: row.key} : {action: 'set', key: row.key, value: row.value});
    return {changes, encoded};
}
