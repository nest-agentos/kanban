/** Host-owned execution resources; the coordination library does not interpret their backend. */
export interface KanbanWorkResource {
    id: string; kind: string; title: string; location: string; version: string;
    archivedAt?:number;
    ownership?: 'current' | 'other' | 'unknown';
    state: 'associated' | 'in-use' | 'retained' | 'cleanup-ready' | 'cleaned' | 'unknown';
    reasons: string[]; properties: Array<{label: string; value: string}>;
    canCleanup: boolean;
}
export interface KanbanWorkResourceQuery {inspect?: boolean;resourceId?:string}
export interface KanbanWorkResourceCleanup {
    operationId: string; itemId: string; resourceId: string; version: string;
}

export interface KanbanWorkResourceTask {
    id:string;number?:number;title:string;status:import('./contracts').KanbanItem['status'];
    taskType:import('./task-type').KanbanTaskType;phase?:import('./task-state').KanbanTaskPhase;
    progress?:Pick<import('./planning').KanbanProgress,'completed'|'total'>;archived?:boolean;deleted?:boolean;
}
export interface KanbanBoardWorkResource extends KanbanWorkResource {
    itemId:string;task?:KanbanWorkResourceTask;coordinationTask?:KanbanWorkResourceTask;
    project?:{id:string;label:string};
}
export interface KanbanBoardWorkResourceQuery {limit?:number;cursor?:string;includeCleaned?:boolean}
export interface KanbanBoardWorkResourcePage {items:KanbanBoardWorkResource[];total:number;nextCursor?:string}
