import {createKanbanModule as createCore, type KanbanModuleHandle as CoreHandle} from './module';
import type {KanbanModuleOptions} from './ports';
import {KanbanError} from './ports';
import type {KanbanSessionActivityQuery, KanbanSessionItemPage, KanbanExecutionSessionDetail} from './contracts';
import {createKanbanSessionActivity, type KanbanSessionActivityOptions} from './session-activity';
export interface KanbanActivityModuleOptions extends KanbanModuleOptions {
    executionSessions?: KanbanSessionActivityOptions;
    referenceSystem: string;
}
export interface KanbanActivityHandle extends CoreHandle {
    queryActivity: (boardId: string, query?: KanbanSessionActivityQuery) => Promise<KanbanSessionItemPage>;
    executionSession: (boardId: string, itemId: string, query?: import('./contracts').KanbanSessionDetailQuery) => Promise<KanbanExecutionSessionDetail>;
}

/** Application integrations stay outside the portable core. */
export function createKanbanActivityModule(options: KanbanActivityModuleOptions): KanbanActivityHandle {
    const {executionSessions, referenceSystem, ...core} = options;
    let activity: ReturnType<typeof createKanbanSessionActivity>;
    const service=createCore({...core,
        authorize:async input=>{await core.authorize(input);await activity.validate(input.board,input.command,input.actor);},
    });
    activity=createKanbanSessionActivity(service,executionSessions,core.log,referenceSystem);
    let stopping = false;
    const pending = new Set<Promise<unknown>>();
    const track = <T>(run: () => Promise<T>): Promise<T> => {
        if (stopping) return Promise.reject(new KanbanError('SERVICE_STOPPING'));
        const work = Promise.resolve().then(run).finally(() => {pending.delete(work);});
        pending.add(work); return work;
    };
    const quiesce = async () => {
        stopping = true;
        await Promise.allSettled([...pending]);
        await service.quiesce();
    };
    return {
        ...forwardCore(service, track),
        queryActivity: (...args) => track(() => activity.queryActivity(...args)),
        executionSession: (...args) => track(() => activity.executionSession(...args)),
        related: sessionId => track(() => relatedBoards(service, referenceSystem, sessionId)),
        quiesce, dispose: quiesce,
    };
}

function forwardCore(service: CoreHandle, track: <T>(run: () => Promise<T>) => Promise<T>): Omit<CoreHandle, 'related' | 'quiesce' | 'dispose'> {
    return {
        create: (input) => track(() => service.create(input)),
        read: (id) => track(() => service.read(id)),
        list: () => track(() => service.list()),
        catalog: () => track(() => service.catalog()),
        execute: (id, request) => track(() => service.execute(id, request)),
        events: (id, after, limit) => track(() => service.events(id, after, limit)),
        query: (id, query) => track(() => service.query(id, query)),
        item: (id, item) => track(() => service.item(id, item)),
        overview: (id) => track(() => service.overview(id)),
        scan: () => track(() => service.scan()),
        workflow: (id) => track(() => service.workflow(id)),
        resolve: (reference) => track(() => service.resolve(reference)),
        suggest: (id, query) => track(() => service.suggest(id, query)),
        records: (id, query) => track(() => service.records(id, query)),
        record: (id, record) => track(() => service.record(id, record)),
        currentPrincipal: () => track(() => service.currentPrincipal()),
    };
}
async function relatedBoards(service: CoreHandle, referenceSystem: string, sessionId: string) {
    const boards = await service.related(sessionId);
    for (const board of await service.catalog()) {
        if (boards.some(old => old.id === board.id)) continue;
        const matches = await service.query(board.id, {view: 'all', reference: {system: referenceSystem, id: sessionId}, limit: 1});
        if (matches.total) boards.push(await service.read(board.id));
    }
    return boards;
}
