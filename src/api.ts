import {createKanbanModule} from './module';
import type {KanbanModuleOptions} from './ports';
import type {KanbanRequest} from './contracts';

export interface KanbanCommit {boardId: string; operationId: string; revision: number}
export type Kanban = ReturnType<typeof createKanban>;

/** Grouped public API; all writes still enter the same authorized transaction path. */
export function createKanban(options: KanbanModuleOptions) {
    const service = createKanbanModule(options);
    return {
        boards: {create: service.create, get: service.read, list: service.catalog, overview: service.overview},
        items: {get: service.item, query: service.query},
        records: {get: service.record, query: service.records},
        planning: {get: service.workflow},
        references: {resolve: service.resolve, suggest: service.suggest},
        currentPrincipal: service.currentPrincipal,
        async execute(boardId: string, request: KanbanRequest): Promise<KanbanCommit> {
            const board = await service.execute(boardId, request);
            return {boardId, operationId: request.operationId, revision: board.revision};
        },
        events: service.events,
        tick: service.scan,
        quiesce: () => service.quiesce(),
        dispose: () => service.dispose(),
    };
}
