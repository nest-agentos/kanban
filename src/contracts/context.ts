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
    coordination?: {manager: KanbanPrincipal; executor?: KanbanPrincipal};
    number?: number;
    originRunId?: string; id: string; kind: 'log' | 'decision'; title: string; content: string; rationale?: string;
    deletedAt?: number; archivedAt?:number; executionEpoch?:string;
    status: 'draft' | 'confirmed' | 'rejected' | 'superseded' | 'cancelling' | 'cancelled';
    itemIds: string[]; sources: KanbanSourceRef[]; author: KanbanPrincipal; origin: 'manual' | 'flow';
    revision: number; createdAt: number; updatedAt: number; reviewedBy?: KanbanPrincipal;
    supersedes?: string; supersededBy?: string;
}
export type KanbanRecordInput = Pick<KanbanProjectRecord, 'id' | 'kind' | 'title' | 'content' | 'rationale' | 'itemIds' | 'sources' | 'supersedes' | 'coordination' | 'externalRefs'>;
export type KanbanRecordSummary = Omit<KanbanProjectRecord, 'content' | 'rationale' | 'sources'> & {sessionIds:string[];attention?:'waiting-input'|'error'|'review'};
export interface KanbanRecordQuery {includeDeleted?: boolean; includeArchived?:boolean; kind?: KanbanProjectRecord['kind']; itemId?: string; status?: KanbanProjectRecord['status']; limit?: number; cursor?: string}
export interface KanbanRecordPage {revision: number; total: number; items: KanbanRecordSummary[]; nextCursor?: string}
