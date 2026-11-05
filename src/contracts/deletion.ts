import type {KanbanWorkResource} from './work-resources';
export interface KanbanDeletionPreview {
    boardId: string; title: string; revision: number; version: string;
    blockers: Array<{code: string; itemId?: string; sessionId?: string}>;
    pendingItems: number;
    pendingDeletion?: {operationId:string;mode:'drain'|'cancel';phase:'waiting'|'ready'|'blocked';code?:string};
    /** Display labels for items referenced by blockers and resources. */
    itemTitles?: Record<string, string>;
    resources: Array<{itemId: string; resource: KanbanWorkResource}>;
}
export interface KanbanDeletionRequest {
    operationId: string; version: string; expectedRevision: number; cleanup: boolean;
}
