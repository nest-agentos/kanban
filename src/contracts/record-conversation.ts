import type {KanbanExternalReference} from './configuration';
export interface KanbanRecordConversationRequest {operationId:string;resources?:KanbanExternalReference[];primaryResource?:KanbanExternalReference}
export interface KanbanRecordConversation {
    id:string;boardId:string;sessionId?:string;resourceId?:string;recordId?:string;
    purpose?:'decision'|'coordination';title?:string;scopeSelectionRequired?:boolean;pendingReports?:Array<{id:string;type:'error'|'clarification';handler?:'self'|'parent'}>;
    state:'preparing'|'clarifying'|'draft'|'confirmed'|'blocked'|'cancelling'|'cancelled'|'error';code?:string;createdAt:number;lastActivityAt?:number;resources?:KanbanExternalReference[];primaryResource?:KanbanExternalReference;
}
