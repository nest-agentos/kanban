import {workLogSnapshots} from './work-log-snapshots';
import {sha256HexSync, randomUUID} from '../utils';
import {KanbanError} from '../ports';
import type {IFileSystem} from '@nestos/vfs-core';
import type {KanbanService, KanbanRecordQuery, KanbanRecordPage, KanbanRecordSummary, KanbanRecordActivity, KanbanExternalReference, KanbanItemSummary} from '../contracts';
import {KanbanWorkLogStore} from './work-log-store';
import {createWorkLogProjection} from './work-log-events';
import {defaultReferences, type KanbanReferencePolicy, type KanbanWorkLogOptions, type KanbanRuntimeDiagnostic} from './ports';
import {requireValue} from '../rules';

export interface WorkLogFact extends KanbanRecordActivity {references?: KanbanExternalReference[]; summary?: string}
interface Cursor {version: 1; board: string; query: string; revision: number; logRevision: number; manual: number; automatic: number}
const order = (a: KanbanRecordSummary, b: KanbanRecordSummary) => b.createdAt - a.createdAt || a.id.localeCompare(b.id);

/** A recoverable read projection; it never appends commands or grows coordination state. */
export class KanbanWorkLog {
    private readonly store: KanbanWorkLogStore;
    private readonly projection;
    private readonly log: (event: KanbanRuntimeDiagnostic) => void;
    constructor(fs: IFileSystem, private readonly options: KanbanWorkLogOptions = {}) {
        this.projection = createWorkLogProjection(options); this.log = event => options.diagnostic?.(event);
        this.store = new KanbanWorkLogStore(fs, options.directory, (options.references ?? defaultReferences).execution);
    }
    open(): Promise<void> {return this.store.open();}
    async synchronize(boardId: string, source: KanbanService): Promise<void> {
        const started = Date.now(), operationId = randomUUID();
        try {
            let after = await this.store.checkpoint(boardId);
            const [page, snapshot] = await Promise.all([source.events(boardId, after, 500), this.store.needsSnapshot(boardId)]); if (!page.length && !snapshot) return;
            const board = {id: boardId}, items = await allItems(source, boardId);
            let events = page; const seenReferences = new Set<string>();
            while (events.length) {
                const records = events.flatMap(event => {
                    if (event.data.reference && event.itemId) seenReferences.add(JSON.stringify([event.itemId, event.data.reference.system, event.data.reference.id]));
                    const activity = this.projection.eventActivity(event); if (!activity || !event.itemId) return [];
                    const item = items.find(item => item.id === event.itemId), reference = event.data.reference;
                    const snapshot = item && event.data.itemTitle ? {...item, title: event.data.itemTitle} : item;
                    const key = factKey(activity, reference ? [reference] : [], event.itemId, 'event:' + event.sequence, this.options.references ?? defaultReferences);
                    return [this.projection.activityRecord(board, snapshot, key, event.at, activity, reference ? [reference] : this.projection.lifecycleReferences(item?.externalRefs), event.data.message, this.projection.ancestorIds(item, items))];
                });
                const through = events.at(-1)!.sequence; await this.store.commit(boardId, after, through, records); after = through;
                if (events.length < 500) break;
                events = await source.events(boardId, after, 500);
            }
            if (snapshot) await this.store.snapshot(boardId, await workLogSnapshots(boardId, source, items, seenReferences, this.projection));
            this.log({operationId, boardId, stage: 'work-log.project', result: 'success', durationMs: Date.now() - started});
        } catch (error) {
            const code = (error as {code?: string})?.code;
            this.log({operationId, boardId, stage: 'work-log.project', result: 'failure', code: code && /^[A-Z_]{1,80}$/.test(code) ? code : 'WORK_LOG_PROJECTION_FAILED', durationMs: Date.now() - started});
            throw error;
        }
    }
    async append(source: KanbanService, boardId: string, itemId: string, fact: WorkLogFact): Promise<void> {
        requireValue(/^[a-z][a-z0-9.-]{0,79}$/.test(fact.stage) && ['success', 'failure', 'cancelled'].includes(fact.result), 'INVALID_WORK_LOG');
        const board = {id: boardId}, items = await allItems(source, boardId), item = items.find(item => item.id === itemId);
        requireValue(item, 'ITEM_NOT_FOUND');
        const {references = [], summary, ...activity} = fact;
        const id = factKey(activity, references, itemId, fact.dispatchId ?? itemId, this.options.references ?? defaultReferences);
        const record = this.projection.activityRecord(board, item, id, Date.now(), activity, references, summary, this.projection.ancestorIds(item, items));
        await this.store.append(boardId, record);
        await this.options.onRecord?.({boardId,itemId,record});
    }
    async record(source: KanbanService, boardId: string, id: string) {
        if (!id.startsWith('activity-')) return source.record(boardId, id);
        await source.records(boardId, {limit: 1}); await this.synchronize(boardId, source);
        return await this.store.record(boardId, id) ?? source.record(boardId, id);
    }
    async records(source: KanbanService, boardId: string, query: KanbanRecordQuery = {}): Promise<KanbanRecordPage> {
        if (query.kind === 'decision' || query.status && query.status !== 'confirmed') return source.records(boardId, query);
        await this.synchronize(boardId, source);
        const {cursor, limit = 50, ...filter} = query, fingerprint = sha256HexSync(JSON.stringify({...filter, limit}));
        requireValue(Number.isSafeInteger(limit) && limit > 0 && limit <= 200, 'INVALID_LIMIT');
        const saved = parseCursor(cursor, boardId, fingerprint);
        const manual = await source.records(boardId, {...filter, limit: 200});
        const automatic = await this.store.page(boardId, query.itemId, saved?.automatic ?? 0, limit);
        if (saved && (saved.revision !== manual.revision || saved.logRevision !== automatic.revision)) throw new KanbanError('CURSOR_STALE');
        const remaining = manual.items.slice(saved?.manual ?? 0), autoIds = new Set(automatic.items.map(item => item.id));
        const items = [...remaining, ...automatic.items].sort(order).slice(0, limit);
        const usedAuto = items.filter(item => autoIds.has(item.id)).length, usedManual = items.length - usedAuto;
        const next: Cursor = {version: 1, board: boardId, query: fingerprint, revision: manual.revision, logRevision: automatic.revision,
            manual: (saved?.manual ?? 0) + usedManual, automatic: (saved?.automatic ?? 0) + usedAuto};
        return {revision: manual.revision, total: manual.total + automatic.total, items,
            ...(next.manual < manual.total || next.automatic < automatic.total ? {nextCursor: JSON.stringify(next)} : {})};
    }
}
async function allItems(source: KanbanService, board: string): Promise<KanbanItemSummary[]> {
    const items: KanbanItemSummary[] = []; let cursor: string | undefined;
    do {const page = await source.query(board, {view: 'all', includeDeleted: true, limit: 200, ...(cursor ? {cursor} : {})}); items.push(...page.items); cursor = page.nextCursor;} while (cursor);
    return items;
}
function parseCursor(cursor: string | undefined, board: string, query: string): Cursor | undefined {
    if (!cursor) return;
    let value: Cursor; try {value = JSON.parse(cursor);} catch {throw new KanbanError('INVALID_CURSOR');}
    requireValue(value?.version === 1 && value.board === board && value.query === query, 'CURSOR_SCOPE_MISMATCH');
    requireValue([value.manual, value.automatic, value.revision, value.logRevision].every(value => Number.isSafeInteger(value) && value >= 0), 'INVALID_CURSOR'); return value;
}
function factKey(activity: KanbanRecordActivity, refs: KanbanExternalReference[], itemId: string, fallback: string, systems: KanbanReferencePolicy): string {
    const tree = refs.find(ref => ref.system === systems.workspace);
    if (tree && activity.stage === 'worktree.prepared') return `${tree.id}:worktree.prepared`;
    if (activity.dispatchId) return `${activity.dispatchId}:${activity.stage}:${activity.code ?? ''}${['execution.running', 'execution.unknown'].includes(activity.stage) && fallback.startsWith('event:') ? ':' + fallback : ''}`;
    const ref = refs.find(ref => [systems.nativeExecution, systems.execution].includes(ref.system));
    return ref ? JSON.stringify([itemId, activity.stage, ref.system, ref.id]) : fallback;
}
