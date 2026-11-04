import type {KanbanWorkResource} from './work-resources';
export interface KanbanDeletionPreview {
    boardId: string; title: string; revision: number; version: string;
    blockers: Array<{code: string; itemId?: string; sessionId?: string}>;
    pendingItems: number;
    resources: Array<{itemId: string; resource: KanbanWorkResource}>;
}
export interface KanbanDeletionRequest {
    operationId: string; version: string; expectedRevision: number; cleanup: boolean;
}
