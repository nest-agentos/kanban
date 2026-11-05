import {boardControlPhase} from './contracts/board-control';
import {projectKanbanTask} from './contracts/task-projection';
import {resolveReference} from './references';
import {suggestFromState, suggestionPage, validateSuggestionQuery} from './suggestions';
import {queryRecords} from './project-records';
import { randomUUID } from './utils';
import type { KanbanBoard, KanbanRequest, KanbanService, KanbanItemQuery, KanbanBoardInput } from './contracts';
import { KanbanError, type KanbanModuleOptions, type KanbanState } from './ports';
import { identity, requireValue } from './rules';
import {createBoardState} from './board';
import {normalizeActor, principal, principalKey, sameOwner} from './identity';
import {queryItems, overview} from './queries';
import {viewFromState} from './storage-codec';
import { reduce, related } from './reducer';

/** Optional host-owned service; no timer or model calls are started implicitly. */
export function createKanbanModule(options: KanbanModuleOptions): KanbanModuleHandle { return new KanbanModule(options); }
export interface KanbanModuleHandle extends KanbanService {quiesce(): Promise<void>; dispose(): Promise<void>}
class KanbanModule implements KanbanService {
    private stopping = false;
    private readonly pending = new Set<Promise<unknown>>();
    async quiesce(): Promise<void> {this.stopping = true; await Promise.allSettled([...this.pending]);}
    async dispose(): Promise<void> {await this.quiesce();}
    private readonly now;
    private readonly id;
    private readonly actor;
    constructor(private readonly options: KanbanModuleOptions) {
        this.now = options.now ?? Date.now; this.id = options.id ?? randomUUID;
        this.actor = normalizeActor(options.actor);
    }
    workflow = (boardId: string) => this.guard(this.id(), boardId, 'workflow', async () => structuredClone((await this.readView(boardId)).state.workflow ?? {plans:{},dispatches:{},ready:[],completedPlans:[]}));
    resolve = (reference: string) => this.guard(this.id(), undefined, 'resolve', () => resolveReference(reference, this.options.store, id => this.readView(id)));
    suggest = (boardId: string, query: import('./contracts').KanbanSuggestionQuery) => this.guard(this.id(), boardId, 'suggest', async () => {
        const snapshot = structuredClone(query), limit = validateSuggestionQuery(snapshot), view = await this.readView(boardId), state = view.state;
        const suggestions = () => suggestFromState(state, snapshot, [...view.items, ...(state.archiveIndex ?? [])], view.records);
        if (!this.options.suggestions) return suggestions();
        const rows = await this.options.suggestions(structuredClone(state.board), snapshot.kind, snapshot.search?.trim() ?? '', limit + 1);
        if (rows === undefined) return suggestions();
        const known = suggestions().items.filter(row => !rows.some(entry => entry.id === row.id));
        return suggestionPage(state.board.revision, [...rows, ...known], snapshot);
    });
    records = (boardId: string, query?: import('./contracts').KanbanRecordQuery) => this.guard(this.id(), boardId, 'records', async () => {const view = await this.readView(boardId); return structuredClone(queryRecords(view.state, query, view.records));});
    record = (boardId: string, recordId: string) => this.guard(this.id(), boardId, 'record', async () => {
        identity(recordId); const record = (await this.readState(boardId)).records?.find(record => record.id === recordId);
        requireValue(record, 'RECORD_NOT_FOUND'); return structuredClone(record);
    });
    currentPrincipal = async () => structuredClone(principal(this.actor));
    create = (input: KanbanBoardInput): Promise<KanbanBoard> => {
        const snapshot = structuredClone(input);
        return this.guard(this.id(), snapshot.id, 'create', async () => {
            const initial = createBoardState(snapshot, this.actor, this.now()), board = initial.board;
            await this.authorize(board, 'create');
            const state = await this.options.store.update(board.id, `create:${board.id}`, JSON.stringify({ snapshot, actor: this.actor }), previous => {
                requireValue(!previous, 'BOARD_EXISTS'); return initial;
            });
            return structuredClone(state.board);
        });
    };
    read = (boardId: string): Promise<KanbanBoard> => this.guard(this.id(), boardId, 'read',
        async () => structuredClone((await this.readState(boardId)).board));
    catalog = () => this.guard(this.id(), undefined, 'catalog', async () => {
        const boards: import('./contracts').KanbanBoardSummary[] = [];
        for (const id of await this.options.store.ids()) {
            try {const view = await this.readView(id); if (view.state.board.deletedAt !== undefined) continue; boards.push({...view.state.board, executionPhase: boardControlPhase({...view.state.board, items: view.items}), items: view.items.map(({id, title, number}) => ({id, title, ...(number === undefined ? {} : {number})}))});}
            catch (error) {if (!(error instanceof KanbanError) || error.code !== 'FORBIDDEN') throw error;}
        }
        return structuredClone(boards);
    });
    list = (): Promise<KanbanBoard[]> => this.guard(this.id(), undefined, 'list', async () => {
        const boards: KanbanBoard[] = [];
        for (const boardId of await this.options.store.ids()) {
            try { const board = (await this.readState(boardId)).board; if (board.deletedAt === undefined) boards.push(structuredClone(board)); }
            catch (error) { if (!(error instanceof KanbanError) || error.code !== 'FORBIDDEN') throw error; }
        }
        return boards;
    });
    execute = (boardId: string, input: KanbanRequest): Promise<KanbanBoard> => this.guard(input.operationId, boardId, `execute:${input.command.type}`, async () => {
        const request = structuredClone(input); identity(request.operationId);
        const state = await this.readState(boardId);
        await this.authorize(state.board, request.command.type, request.command);
        requireValue(state.board.deletedAt === undefined, 'BOARD_DELETED');
        if (request.command.type === 'delete-board') await this.options.verifyDeletion?.(structuredClone(state.board));
        await this.verifyRelease(state.board, request.command);
        const verifyStage = request.command.type === 'observe-execution' && request.command.outcome === 'succeeded' ? 'observe'
            : request.command.type === 'accept-execution' && request.command.accept ? 'accept' : undefined;
        if (verifyStage && 'dispatchId' in request.command) {
            const dispatch = state.workflow?.dispatches[request.command.dispatchId]; requireValue(dispatch, 'DISPATCH_NOT_FOUND');
            const outputs = request.command.type === 'observe-execution' ? request.command.outputs : dispatch.outputs;
            if (outputs?.length) requireValue(await this.options.verifyOutputs?.({stage: verifyStage, board: state.board, itemId: dispatch.itemId,
                dispatchId: dispatch.id, outputs: structuredClone(outputs)}), 'OUTPUT_VERIFICATION_REQUIRED');
        }
        const restore = request.command.type === 'restore-item' ? await this.options.store.archived(boardId, request.command.itemId) : undefined;
        const result = await this.options.store.update(boardId, request.operationId, JSON.stringify({ actor: this.actor, request }), current => {
            requireValue(current && current.board.revision === state.board.revision, 'REVISION_CONFLICT');
            requireValue(current.board.revision === request.expectedRevision, 'REVISION_CONFLICT');
            if (restore) current.restore = restore;
            return reduce(current, request.command, this.actor, request.operationId, this.now(), this.id());
        });
        await this.publishNotifications(boardId, request.operationId);
        return structuredClone(result.board);
    });
    events = (boardId: string, after = 0, limit = 100) => this.guard(this.id(), boardId, 'events', async () => {
        requireValue(Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 500, 'INVALID_CURSOR');
        const {state} = await this.readView(boardId);
        return this.options.store.events(boardId, after, limit, state.sequence);
    });
    query = (boardId: string, query?: KanbanItemQuery) => this.guard(this.id(), boardId, 'query', async () => {const view = await this.readView(boardId); return structuredClone(queryItems(view.state, query, [...view.items, ...(view.state.archiveIndex ?? [])], this.now()));});
    overview = (boardId: string) => this.guard(this.id(), boardId, 'overview', async () => {const view = await this.readView(boardId); return overview(view.state, this.now(), view.items);});
    item = (boardId: string, itemId: string) => this.guard(this.id(), boardId, 'item', async () => {
        identity(itemId); const state = await this.readState(boardId), item = state.board.items.find(i => i.id === itemId);
        if (item) return {item: structuredClone(item),task:projectKanbanTask(item,state.workflow,this.now(),[...state.board.items,...state.archiveIndex??[]])};
        requireValue(state.archiveIndex?.some(i => i.id === itemId), 'ITEM_NOT_FOUND');
        const record = await this.options.store.archived(boardId, itemId); requireValue(record, 'REVISION_CONFLICT');
        return {item: structuredClone(record.item), task:projectKanbanTask(record.item,state.workflow,this.now(),state.archiveIndex), archive: {archivedAt: record.archivedAt, reason: record.reason}};
    });
    related = (sessionId: string): Promise<KanbanBoard[]> => this.guard(this.id(), undefined, 'related', async () => {
        identity(sessionId); const result: KanbanBoard[] = [];
        for (const board of await this.list()) {
            const state = await this.readState(board.id);
            if (related(board).includes(sessionId) || state.records?.some(record => record.sources.some(source => source.sessionId === sessionId)) || state.archiveIndex?.some(i => i.sessionIds.includes(sessionId))) result.push(board);
        }
        return result;
    });
    scan = (): Promise<void> => this.guard(this.id(), undefined, 'scan', async () => {
        const errors: unknown[] = [];
        for (const id of await this.options.store.ids()) {
            try {
                const board = (await this.readState(id)).board;
                if (board.deletedAt !== undefined) {await this.publishNotifications(id,this.id()); continue;}
                await this.execute(board.id, { operationId: this.id(), expectedRevision: board.revision, command: { type: 'scan' } });
            }
            catch (error) {
                if (!(error instanceof KanbanError) || !['REVISION_CONFLICT','FORBIDDEN'].includes(error.code)) errors.push(error);
            }
        }
        if (errors.length) throw new AggregateError(errors, 'KANBAN_SCAN_FAILED');
    });
    private async verifyRelease(board: KanbanBoard, command: KanbanRequest['command']): Promise<void> {
        if (command.type !== 'release-item') return;
        const item = board.items.find(i => i.id === command.itemId); requireValue(item?.owner && item.owner.token === command.token, 'OWNER_MISMATCH');
        const own = sameOwner(item.owner, this.actor), actor = principal(this.actor);
        const coordinator = board.members?.some(m => principalKey(m) === principalKey(actor) && m.roles?.includes('coordinator'));
        requireValue(own || coordinator, 'OWNER_MISMATCH');
        if (!(own && actor.kind === 'human')) requireValue(await this.options.verifyRelease?.({actor: this.actor, board: structuredClone(board), item: structuredClone(item)}), 'EXECUTION_NOT_SETTLED');
    }
    private async publishNotifications(boardId: string, operationId: string): Promise<void> {
        if (!this.options.onCommitted) return;
        const started = this.now();
        try {await this.options.onCommitted(boardId, this, this.now()); this.log(operationId, boardId, 'notify', started, 'success');}
        catch (error) {this.log(operationId, boardId, 'notify', started, 'failure', safeCode(error, 'NOTIFICATION_PROJECTION_FAILED'));}
    }
    private async readView(boardId: string) {
        identity(boardId);
        if (!this.options.store.view) return viewFromState(await this.readState(boardId));
        const view = await this.options.store.view(boardId); requireValue(view, 'BOARD_NOT_FOUND');
        await this.authorize(view.state.board, 'read'); return view;
    }
    private async readState(boardId: string): Promise<KanbanState> {
        identity(boardId); const state = await this.options.store.read(boardId); requireValue(state, 'BOARD_NOT_FOUND');
        await this.authorize(state.board, 'read'); return state;
    }
    private authorize(board: KanbanBoard, action: Parameters<KanbanModuleOptions['authorize']>[0]['action'], command?: KanbanRequest['command']) {
        return this.options.authorize({ actor: structuredClone(this.actor), board: structuredClone(board), action, command: structuredClone(command) });
    }
    private async guard<T>(operationId: string, boardId: string | undefined, stage: string, run: () => Promise<T>): Promise<T> {
        const start = this.now();
        if (this.stopping) {this.log(operationId,boardId,stage,start,'failure','SERVICE_STOPPING'); throw new KanbanError('SERVICE_STOPPING');}
        const operation = Promise.resolve().then(run); this.pending.add(operation);
        try { const result = await operation; this.log(operationId, boardId, stage, start, 'success'); return result; }
        catch (error) {
            this.log(operationId, boardId, stage, start, 'failure', safeCode(error, 'PORT_FAILURE')); throw error;
        } finally {this.pending.delete(operation);}
    }
    private log(operationId: string, boardId: string | undefined, stage: string, start: number, result: 'success' | 'failure', code?: string): void {
        try { this.options.log({ operationId, boardId, stage, result, code, durationMs: this.now() - start }); }
        catch { /* Diagnostics cannot undo a commit. */ }
    }
}

function safeCode(error: unknown, fallback: string): string {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : fallback;
}
