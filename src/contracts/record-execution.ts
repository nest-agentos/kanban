import type {KanbanExternalReference} from './configuration';

/** Hosts resolve opaque resources and execute records; the library owns no project policy. */
export interface KanbanRecordResource {reference: KanbanExternalReference; label: string;group?:string}
export interface KanbanItemResourceCatalog {resources:KanbanRecordResource[];selected?:KanbanExternalReference;required?:boolean;readonly?:boolean}
export interface KanbanRecordExecution {
    dependencies?:Array<import('./context').KanbanDecisionDependency&{state:'waiting'|'completed'|'unavailable'}>;
    id: string; recordId: string; recordRevision: number; boardId: string;
    scheduledAt?:number; recurrenceRevision?:number;
    completion?:import('./task-state').KanbanTaskProjection['completion'];
    rootItemId?: string; itemIds?: string[]; stage?:'planning'|'execution';
    state: 'preparing' | 'running' | 'blocked' | 'review' | 'completed' | 'failed' | 'cancelling' | 'cancelled' | 'pausing' | 'paused' | 'resuming' | 'unknown';
    createdAt: number; updatedAt: number; archivedAt?:number; code?: string;
}
export interface KanbanRecordExecutionPage {items:KanbanRecordExecution[];active:KanbanRecordExecution[];nextCursor?:string}
export interface KanbanRecordRunRequest {
    operationId: string; recordId: string; expectedRevision: number;
    placement?: 'current-board' | 'new-board';
}
