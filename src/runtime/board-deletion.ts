import type {KanbanAutomationJournal} from './automation-journal';
import {runtimeLogger} from './logging';
import {createBoardStop} from './board-stop';
import {randomUUID, sha256HexSync} from '../utils';
import type {KanbanClient, KanbanDeletionPreview, KanbanDeletionRequest} from '../contracts';
import {KanbanError} from '../ports';
import {requireValue} from '../rules';
import {safeCode} from './diagnostics';
import {boardDeletionBlockers, deletionPreview, type Options} from './board-deletion-inspection';

/** A retained tombstone preserves audit and resource provenance without owning Sessions. */
export function createBoardDeletion(options: Options) {
    const stop = createBoardStop(options,(board,request)=>removeBoard(options,board,request));
    return {...stop,
        previewDeletion: (id: string) => traced(id, randomUUID(), 'preview', () => deletionPreview(options, id), options.journal),
        assertSettled: async (id: string) => {const rows = await boardDeletionBlockers(options, id); requireValue(!rows.length, rows[0]?.code ?? 'BOARD_EXECUTION_UNSETTLED');},
        deleteBoard: (id: string, request: KanbanDeletionRequest) => traced(id, request.operationId, 'delete', () => removeBoard(options, id, request), options.journal),
    };
}
interface Receipt {request: KanbanDeletionRequest; preview: KanbanDeletionPreview; phase: string}
async function removeBoard(options: Options, id: string, request: KanbanDeletionRequest): Promise<void> {
    const {service, journal} = options;
    requireValue(/^[\w-]{1,128}$/.test(request.operationId) && typeof request.cleanup === 'boolean' && /^[a-f0-9]{64}$/.test(request.version), 'INVALID_OPERATION_ID');
    const key = 'board-deletion:' + id, receipt = await journal.get<Receipt>(key);
    if (receipt?.request.operationId === request.operationId) {
        requireValue(JSON.stringify(receipt.request) === JSON.stringify(request), 'IDEMPOTENCY_CONFLICT');
        if ((await service.read(id)).deletedAt !== undefined) return;
    }
    const current = await deletionPreview(options, id);
    requireValue(current.revision === request.expectedRevision && current.version === request.version, 'BOARD_DELETE_PREVIEW_CHANGED');
    requireValue(!current.blockers.length, current.blockers[0]?.code ?? 'BOARD_EXECUTION_UNSETTLED');
    await journal.update(key, () => ({request, preview: current, phase: 'prepared'}));
    if (request.cleanup) await cleanupResources(options, id, request, current);
    const board = await service.read(id);
    requireValue(board.revision === request.expectedRevision, 'BOARD_DELETE_PREVIEW_CHANGED');
    await service.execute(id, {operationId: request.operationId, expectedRevision: board.revision, command: {type: 'delete-board'}});
    await journal.update<Receipt>(key, old => ({...old!, phase: 'deleted'}));
}
async function cleanupResources({service, journal}: Options, id: string, request: KanbanDeletionRequest, preview: KanbanDeletionPreview): Promise<void> {
    const groups = new Map<string, KanbanDeletionPreview['resources']>();
    for (const row of preview.resources) {
        const key = JSON.stringify([row.resource.kind, row.resource.id, row.resource.location]);
        const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
    }
    for (const group of groups.values()) if (group.every(row => row.resource.canCleanup && row.resource.ownership !== 'other' && row.resource.ownership !== 'unknown')) {
        const {itemId, resource} = group[0];
        requireValue(service.cleanupWorkResource, 'WORK_RESOURCE_CLEANUP_UNAVAILABLE');
        await traced(id, request.operationId, 'cleanup', () => service.cleanupWorkResource!(id, {itemId, resourceId: resource.id, version: resource.version,
            operationId: sha256HexSync(JSON.stringify([request.operationId, resource.id]))}), journal);
    }
}
async function traced<T>(boardId: string, operationId: string, stage: string, run: () => Promise<T>, journal: KanbanAutomationJournal): Promise<T> {
    const log = runtimeLogger(journal);
    const started = Date.now(); operationId = /^[\w-]{1,128}$/.test(operationId) ? operationId : randomUUID();
    try {const result = await run(); log.info('board.deletion', {operation: 'kanban.board.delete', boardId, operationId, stage, result: 'success', durationMs: Date.now() - started}); return result;}
    catch (error) {log.warn('board.deletion', {operation: 'kanban.board.delete', boardId, operationId, stage, result: 'failure', code: safeCode(error, 'BOARD_DELETE_FAILED'), durationMs: Date.now() - started}); throw error;}
}

/** Concurrent admissions share an exclusive deletion barrier; queries never wait for scans. */
export function withBoardDeletion<T extends KanbanClient & {quiesce?(): Promise<void>; dispose?(): Promise<void>}>(service: T, deletion: ReturnType<typeof createBoardDeletion>): T & Pick<typeof deletion, 'previewDeletion' | 'deleteBoard'> {
    let barrier: Promise<unknown> = Promise.resolve(), stopping = false;
    const pending = new Set<Promise<unknown>>();
    const items = new Map<string, Promise<unknown>>();
    const itemMutation = <R>(board: string, item: string, run: () => Promise<R>, checkDeleted = true): Promise<R> => {
        const key = JSON.stringify([board,item]);
        const next = (items.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
            if (checkDeleted) requireValue((await service.item(board,item)).item.deletedAt === undefined, 'ITEM_DELETED');
            return run();
        });
        items.set(key,next);
        void next.finally(() => {if (items.get(key) === next) items.delete(key);}).catch(() => {});
        return next;
    };
    let quiescing: Promise<void> | undefined, disposing: Promise<void> | undefined;
    const quiesce = () => {
        stopping = true;
        if (!quiescing) {
            // Broadcast immediately, including while an exclusive operation is finishing.
            const acknowledgements = Promise.allSettled([service.quiesce?.() ?? Promise.resolve(), ...pending]);
            quiescing = (async () => {
                await barrier;
                const [ack] = await acknowledgements;
                if (ack.status === 'rejected') throw ack.reason;
            })();
        }
        return quiescing;
    };
    const close = (method: 'quiesce' | 'dispose') => method === 'quiesce' ? quiesce()
        : disposing ??= quiesce().then(() => service.dispose?.());
    const admit = <R>(run: () => Promise<R>): Promise<R> => {
        if (stopping) return Promise.reject(new KanbanError('SERVICE_STOPPING'));
        const next = barrier.then(run); pending.add(next); void next.finally(() => pending.delete(next)).catch(() => {}); return next;
    };
    const exclusive = <R>(run: () => Promise<R>): Promise<R> => {
        if (stopping) return Promise.reject(new KanbanError('SERVICE_STOPPING'));
        const admitted = [...pending], next = barrier.then(async () => {await Promise.allSettled(admitted); return run();});
        barrier = next.catch(() => {}); return next;
    };
    const active = async <R>(id: string, run: () => Promise<R>) => {requireValue((await service.read(id)).deletedAt === undefined, 'BOARD_DELETED'); return run();};
    return {...service, ...(service.quiesce ? {quiesce: () => close('quiesce')} : {}), ...(service.dispose ? {dispose: () => close('dispose')} : {}), previewDeletion: deletion.previewDeletion, deleteBoard: (id, request) => exclusive(() => deletion.deleteBoard(id, request)),
        execute: (id, request) => admit(() => active(id, () => {if (request.command.type === 'delete-board') throw new KanbanError('BOARD_DELETE_CONFIRMATION_REQUIRED'); return 'itemId' in request.command && request.command.itemId ? itemMutation(id,request.command.itemId,() => service.execute(id,request),false) : service.execute(id, request);})),
        scan: async () => {await admit(async () => {await deletion.preparePending();await service.scan();});if (!stopping) await exclusive(() => deletion.resumePending());},
        cancelBoard: (id,request) => admit(() => active(id,()=>deletion.cancelBoard(id,request))),
        requestBoardDeletion: (id,request) => admit(() => active(id,()=>deletion.requestBoardDeletion(id,request))),
        ...(service.cancelFix ? {cancelFix: (id: string, request: Parameters<NonNullable<T['cancelFix']>>[1]) => admit(() => active(id, () => service.cancelFix!(id, request)))} : {}),
        ...(service.controlRecord ? {controlRecord: (id: string, request: Parameters<NonNullable<T['controlRecord']>>[1]) => admit(() => active(id, () => service.controlRecord!(id, request)))} : {}),
        ...(service.fixTask ? {fixTask: (id: string, request: Parameters<NonNullable<T['fixTask']>>[1]) => admit(() => active(id, () => itemMutation(id,request.itemId,() => service.fixTask!(id, request))))} : {}),
        ...(service.replyTask ? {replyTask: (id: string, request: Parameters<NonNullable<T['replyTask']>>[1]) => admit(() => active(id, () => itemMutation(id,request.itemId,() => service.replyTask!(id, request))))} : {}),
        ...(service.runRecord ? {runRecord: (id: string, request: Parameters<NonNullable<T['runRecord']>>[1]) => admit(() => active(id, () => service.runRecord!(id, request)))} : {}),
        ...(service.runItemOperation ? {runItemOperation: (id: string, request: Parameters<NonNullable<T['runItemOperation']>>[1]) => admit(() => active(id, () => itemMutation(id,request.itemId,() => service.runItemOperation!(id, request))))} : {}),
        ...(service.bindItemOperation ? {bindItemOperation: (id: string, request: Parameters<NonNullable<T['bindItemOperation']>>[1]) => admit(() => active(id, () => itemMutation(id,request.itemId,() => service.bindItemOperation!(id, request))))} : {}),
        ...(service.cleanupWorkResource ? {cleanupWorkResource: (id: string, request: Parameters<NonNullable<T['cleanupWorkResource']>>[1]) => admit(() => service.cleanupWorkResource!(id, request))} : {}),
    };
}
