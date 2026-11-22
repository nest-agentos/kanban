import type {KanbanRecurrence} from './recurrence';
import type {KanbanExternalReference} from './configuration';
export interface KanbanDecisionModule {id:string;version:string;label:string;description?:string}
export interface KanbanRecordConversationRequest {operationId:string;resources?:KanbanExternalReference[];primaryResource?:KanbanExternalReference;moduleIds?:string[];recurrence?:KanbanRecurrence|null}
export interface KanbanRecordConversation {
    id:string;boardId:string;sessionId?:string;resourceId?:string;recordId?:string;
    attentionFingerprint?:string;
    attentionDismissal?:{fingerprint:string;operationId:string;at:number};
    unavailable?:{kind:'project'|'session';code:string;cleanupAllowed:boolean};
    purpose?:'decision'|'coordination';title?:string;scopeSelectionRequired?:boolean;pendingReports?:Array<{id:string;type:'error'|'clarification';handler?:'self'|'parent'}>;
    moduleIds?:string[];
    recurrence?:KanbanRecurrence|null;
    state:'preparing'|'clarifying'|'draft'|'confirmed'|'blocked'|'cancelling'|'cancelled'|'error';code?:string;createdAt:number;lastActivityAt?:number;resources?:KanbanExternalReference[];primaryResource?:KanbanExternalReference;
}

export interface KanbanRecordConversationControl {
    conversationId:string;operationId:string;action:'dismiss-attention'|'cleanup-reference'|'remove-draft';fingerprint:string;confirmed?:boolean;
}

/** Removing a draft entry never cancels its native Session or removes a formal decision. */
export function conversationDraftRemovalBlocker(value:KanbanRecordConversation):string|undefined {
    if(value.recordId||value.purpose==='coordination'||value.state==='confirmed')return 'CONVERSATION_HAS_RECORD';
    if(value.state==='preparing')return 'CONVERSATION_SUBMISSION_UNSETTLED';
}

export interface KanbanRecordDraftRemovalRequest {requests:KanbanRecordConversationControl[]}
export interface KanbanRecordDraftRemovalResult {items:Array<{conversationId:string;outcome:'removed'|'failed'|'unknown';code?:string}>}
