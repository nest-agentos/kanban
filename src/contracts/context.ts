import type {KanbanPrincipal} from './configuration';
import type {KanbanSourceRef} from './source';
export interface KanbanText {title: string; responsibility: string; acceptance: string}
export interface KanbanAmendment {
    runId: string; id: string; fingerprint: string; baseRevision: number; baseDigest: string; proposed: KanbanText;
    proposedBy: KanbanPrincipal; sources: KanbanSourceRef[]; createdAt: number;
    status: 'pending' | 'accepted' | 'rejected'; reviewedAt?: number; reviewedBy?: KanbanPrincipal; reason?: string;
}
export interface KanbanRecordActivity {
    actor?: KanbanPrincipal; stage: string; result: 'success' | 'failure' | 'cancelled'; dispatchId?: string; code?: string; fields?: Record<string, string | number>;
}
export interface KanbanProjectRecord {
    /** Immutable, host-projected activity; decisions remain in the coordination store. */
    activity?: KanbanRecordActivity;
    externalRefs?: import('./configuration').KanbanExternalReference[];
    completion?:'manual'|'automatic';
    discussionSessionId?:string;
    verificationLevel?: 'full' | 'quick' | 'none';
    deliveryMode?: 'release' | 'source' | 'build';
    coordination?: {manager: KanbanPrincipal; executor?: KanbanPrincipal};
    number?: number;
    originRunId?: string; id: string; kind: 'log' | 'decision'; title: string; content: string; rationale?: string;
    deletedAt?: number; archivedAt?:number; executionEpoch?:string;
    status: 'draft' | 'confirmed' | 'rejected' | 'superseded' | 'cancelling' | 'cancelled';
    itemIds: string[]; sources: KanbanSourceRef[]; author: KanbanPrincipal; origin: 'manual' | 'flow';
    revision: number; createdAt: number; updatedAt: number; reviewedBy?: KanbanPrincipal;
    supersedes?: string; supersededBy?: string;
}
export type KanbanRecordInput = Pick<KanbanProjectRecord, 'id' | 'kind' | 'title' | 'content' | 'rationale' | 'itemIds' | 'sources' | 'supersedes' | 'coordination' | 'externalRefs' | 'completion' | 'verificationLevel' | 'deliveryMode' | 'discussionSessionId'>;
export interface KanbanRecordParticipationTarget {
    itemId:string;title:string;purpose:'management'|'execution';phase:import('./task-state').KanbanTaskPhase;
}
export interface KanbanRecordProgress {
    participation?:{reason:'needs-action'|'running'|'management';targets:KanbanRecordParticipationTarget[]};
    stage?:'management'|'execution'|'finalization';
    tasks?:{management:import('./planning').KanbanProgress;execution:import('./planning').KanbanProgress};
    state: 'draft' | 'waiting' | 'running' | 'needs-action' | 'failed' | 'completed' | 'checking' | 'cancelling' | 'cancelled' | 'rejected' | 'superseded';
    phase?: import('./task-state').KanbanTaskPhase | 'planning' | 'execution';
    completion?: import('./task-state').KanbanTaskProjection['completion']; groupIds?:string[];
    followUps?:Array<{boardId:string;itemId:string;state:'pending'|'blocked'|'unknown';phase:string;code?:string;requiresConfirmation?:boolean}>;
    reason?: string; boardId?:string; itemId?: string; sessionId?: string; lastActivityAt: number;
}
export interface KanbanRecordAttentionDismissal {fingerprint:string;operationId:string;actor:KanbanPrincipal;at:number}
export type KanbanRecordSummary = Omit<KanbanProjectRecord, 'content' | 'rationale' | 'sources'> & {attentionDismissal?:KanbanRecordAttentionDismissal;progress?:KanbanRecordProgress;sessionIds:string[];attention?:'waiting-input'|'error'|'review';attentionCode?:string;attentionItemId?:string;attentionTasks?:Array<{itemId:string;title:string;phase:'waiting-input'|'error'|'unknown';purpose:'planning'|'execution';sessionId?:string}>};
export interface KanbanRecordQuery {resource?:import('./configuration').KanbanExternalReference;includeDeleted?: boolean; includeArchived?:boolean; kind?: KanbanProjectRecord['kind']; itemId?: string; status?: KanbanProjectRecord['status']; limit?: number; cursor?: string}
export interface KanbanRecordPage {revision: number; total: number; items: KanbanRecordSummary[]; nextCursor?: string}
