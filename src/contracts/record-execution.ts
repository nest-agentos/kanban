import type {KanbanExternalReference} from './configuration';

/** Hosts resolve opaque resources and execute records; the library owns no project policy. */
export interface KanbanRecordResource {reference: KanbanExternalReference; label: string}
export interface KanbanItemResourceCatalog {resources:KanbanRecordResource[];selected?:KanbanExternalReference;required?:boolean;readonly?:boolean}
export interface KanbanRecordExecution {
    id: string; recordId: string; recordRevision: number; boardId: string;
    rootItemId?: string; itemIds?: string[];
    state: 'preparing' | 'running' | 'blocked' | 'review' | 'completed' | 'failed' | 'cancelling' | 'cancelled' | 'pausing' | 'paused' | 'resuming' | 'unknown';
    createdAt: number; updatedAt: number; code?: string;
}
export interface KanbanRecordRunRequest {
    operationId: string; recordId: string; expectedRevision: number;
    placement?: 'current-board' | 'new-board';
}
