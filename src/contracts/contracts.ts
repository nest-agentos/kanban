import type {KanbanAmendment, KanbanRecordInput, KanbanProjectRecord, KanbanRecordPage, KanbanRecordQuery} from './context';
import type {KanbanPrincipal, KanbanMember, KanbanWorkType, KanbanColumn, KanbanNotificationPolicy, KanbanExternalReference} from './configuration';
import type {KanbanPlanning, KanbanItemQuery, KanbanItemPage, KanbanArchivedItem, KanbanOverview} from './planning';
import type {KanbanSourceRef, KanbanDiscoveryBatch} from './source';
export interface KanbanActor {kind?: KanbanPrincipal['kind']; id?: string; agentId?: string; sessionId?: string; taskId?: string}
export interface KanbanEstimate {
    complexity: number; workUnits: number; durationMs: number; confidence: 'low' | 'medium' | 'high';
}
export interface KanbanPolicy {
    maxInProgressPerAssignee?: number; requireEstimate?: boolean; review?: 'independent' | 'assignee';
    maxReady?: number; maxInProgress?: number; maxInProgressPerAgent?: number; archiveAfterMs?: number; backlogReviewMs?: number;
    claimTimeoutMs: number; leaseMs: number; progressTimeoutMs: number; transferTimeoutMs: number;
    maxComplexity: number; maxWorkUnits: number; maxDurationMs: number; escalationSessionIds: string[];
}
export interface KanbanParticipant {
    sessionId: string; agentId?: string; roles: Array<'creator' | 'owner' | 'consultant' | 'reviewer' | 'observer' | 'escalation'>;
    joinedAt: number; subscribed: boolean;
}
export interface KanbanAssignment extends KanbanActor { principalId?: string; token: string; leaseUntil: number; claimedAt: number; }
export interface KanbanItem {
    repairPending?:{itemId:string;previousDispatchId:string};
    executionEpoch?:string;restartPending?:{id:string;rootItemId:string};
    purpose?:'planning';
    launch?: import('./task-state').KanbanLaunch; analysis?: import('./automation').KanbanAnalysisStatus;
    control?: import('./task-state').KanbanTaskControl; issues?: import('./task-state').KanbanTaskIssue[];
    deletedAt?: number;
    restartedFrom?: string;
    number?: number;
    origin?: {kind: 'direct' | 'discovery'; principal: KanbanPrincipal; runId?: string; fingerprint?: string}; amendments?: KanbanAmendment[];
    id: string; title: string; responsibility: string; acceptance: string; eligibleAgentIds?: string[]; eligiblePrincipals?: KanbanPrincipal[];
    status: 'proposed' | 'backlog' | 'open' | 'claimed' | 'review' | 'completed' | 'cancelled'; revision: number;
    createdAt: number; readyAt: number; updatedAt: number; progressAt?: number;
    owner?: KanbanAssignment; estimate?: KanbanEstimate; workUnits: number; resultRef?: string;
    transfer?: { id: string; agentId?: string; target?: KanbanPrincipal; requestedAt: number; expiresAt: number };
    participants: KanbanParticipant[];
    sources?: KanbanSourceRef[];
    externalRefs?: KanbanExternalReference[];
    blocked?: {reason: string; at: number};
    planning?: KanbanPlanning; closedAt?: number; restoredAt?: number; closureReason?: string;
}
export interface KanbanBoard {
    lifecycle?: {operationId: string; intent: 'cancel' | 'delete'; mode: 'drain' | 'cancel'; phase: 'waiting' | 'ready' | 'blocked'; code?: string};
    /** Logical deletion retains audit, Session and resource associations. */
    deletedAt?: number;
    executionControl?: import('./board-control').KanbanBoardControl;
    automation?: import('./automation').KanbanAutomationSettings;
    number?: number;
    id: string; scope: { kind: 'system' } | { kind: 'project'; projectId: string } | {kind: 'collection'; namespace: string; id: string};
    title: string; policy: KanbanPolicy; agents?: Array<{ agentId: string; responsibility: string }>; members?: KanbanMember[];
    workTypes?: KanbanWorkType[]; defaultWorkType?: string; columns?: KanbanColumn[]; notifications?: KanbanNotificationPolicy; revision: number; items: KanbanItem[];
    participants: KanbanParticipant[];
}
export interface KanbanEvent {
    sequence: number; boardId: string; itemId?: string; operationId: string; at: number;
    kind: string; actor: KanbanActor; recipients: string[];
    data: { status?: KanbanItem['status']; reference?: KanbanExternalReference; code?: string; itemTitle?: string; dispatchId?: string; readyItemIds?: string[]; planId?: string; recordId?: string; recordIds?: string[]; itemIds?: string[]; planning?: KanbanPlanning; message?: string; reason?: string; resultRef?: string; estimate?: KanbanEstimate; workUnits?: number };
}
export type KanbanCommand = import('./task-restart').RepairDependencyCommand | import('./task-restart').KanbanRestartCommand | import('./record-revision').KanbanRecordRevisionCommand | import('./task-state').KanbanTaskCommand | import('./workflow').KanbanWorkflowCommand
    | {type: 'restart-item'; itemId: string; replacementId: string}
    | {type: 'delete-item'; itemId: string}
    | {type: 'request-record-cancellation'; recordId: string}
    | {type: 'cancel-record'; recordId: string}
    | {type: 'delete-record'; recordId: string}
    | {type:'archive-record';recordId:string}
    | {type:'revise-record';recordId:string;title:string;content:string;rationale:string;externalRefs?:import('./configuration').KanbanExternalReference[];completion?:'manual'|'automatic';verificationLevel?:'full'|'quick'|'none';deliveryMode?:'release'|'source'|'build'}
    | {type:'restart-record';recordId:string;epoch:string}
    | {type:'request-board-stop'; controlId:string; intent:'cancel'|'delete'; mode:'drain'|'cancel'}
    | {type:'observe-board-stop'; controlId:string; phase:'waiting'|'ready'|'blocked'; code?:string}
    | {type: 'delete-board'}
    | {type: 'set-board-control'; mode?: 'automatic' | 'manual'; paused?: boolean}
    | {type: 'edit-item'; itemId: string; title: string; responsibility: string; acceptance: string}
    | {type: 'configure-automation'; settings: import('./automation').KanbanAutomationSettings}
    | {type: 'review-amendment'; itemId: string; amendmentId: string; accept: boolean; reason?: string}
    | {type: 'append-record'; record: KanbanRecordInput}
    | {type: 'review-record'; recordId: string; accept: boolean}
    | {type: 'link-record'; recordId: string; itemId: string}
    | { type: 'create-item'; item: Pick<KanbanItem, 'title' | 'responsibility' | 'acceptance' | 'eligibleAgentIds' | 'eligiblePrincipals' | 'externalRefs' | 'purpose'> & {id?: string}; planning?: KanbanPlanning; stage?: 'backlog' | 'open'; launch?: {mode?: 'automatic' | 'manual'; paused?: boolean} }
    | { type: 'register-session'; itemId?: string; sessionId: string; agentId?: string; role: KanbanParticipant['roles'][number]; subscribed: boolean }
    | { type: 'claim'; itemId: string; estimate?: KanbanEstimate }
    | { type: 'renew'; itemId: string; token: string }
    | { type: 'progress'; itemId: string; token: string; workUnits: number; estimate?: KanbanEstimate }
    | { type: 'request-transfer'; itemId: string; token: string; agentId?: string; target?: KanbanPrincipal }
    | { type: 'accept-transfer'; itemId: string; estimate?: KanbanEstimate }
    | { type: 'submit'; itemId: string; token: string; resultRef: string }
    | { type: 'review'; itemId: string; accept: boolean }
    | { type: 'message'; itemId?: string; message: string; recipientSessionIds: string[] }
    | { type: 'scan' }
    | { type: 'apply-discovery'; batch: KanbanDiscoveryBatch }
    | { type: 'publish-proposal'; itemId: string; stage?: 'backlog' | 'open' }
    | { type: 'plan-item'; itemId: string; planning: KanbanPlanning }
    | { type: 'set-stage'; itemId: string; stage: 'backlog' | 'open' }
    | { type: 'cancel-item'; itemId: string; reason: string }
    | { type: 'close-plan'; itemId: string; resultRef: string }
    | { type: 'archive-items'; itemIds: string[]; reason: string }
    | { type: 'restore-item'; itemId: string }
    | {type: 'release-item'; itemId: string; token: string; next: 'backlog' | 'cancelled'; reason: string}
    | {type: 'link-reference'; itemId: string; reference: KanbanExternalReference}
    | {type: 'block-item'; itemId: string; reason: string; token?: string}
    | {type: 'unblock-item'; itemId: string; token?: string};
export interface KanbanRequest { operationId: string; expectedRevision: number; command: KanbanCommand; }
/** Board directory metadata with item labels; coordination bodies require read()/item(). */
export type KanbanBoardSummary = Omit<KanbanBoard, 'items'> & {attention?:{board:number;decision:number;log:number};executionPhase?: ReturnType<typeof import('./board-control').boardControlPhase>; items: Array<Pick<KanbanItem, 'id' | 'title' | 'number'>>};
export interface KanbanService {
    workflow(boardId: string): Promise<import('./workflow').KanbanWorkflowState>;

    resolve(reference: string): Promise<import('./references').KanbanReferenceTarget>;
    suggest(boardId: string, query: import('./suggestions').KanbanSuggestionQuery): Promise<import('./suggestions').KanbanSuggestionPage>;
    records(boardId: string, query?: KanbanRecordQuery): Promise<KanbanRecordPage>;
    record(boardId: string, recordId: string): Promise<KanbanProjectRecord>;
    currentPrincipal(): Promise<KanbanPrincipal>;
    create(board: KanbanBoardInput): Promise<KanbanBoard>;
    /** Full coordination snapshot; user-facing lists should use query(). */
    read(boardId: string): Promise<KanbanBoard>;
    list(): Promise<KanbanBoard[]>;
    catalog(): Promise<KanbanBoardSummary[]>;
    execute(boardId: string, request: KanbanRequest): Promise<KanbanBoard>;
    events(boardId: string, afterSequence?: number, limit?: number): Promise<KanbanEvent[]>;
    related(sessionId: string): Promise<KanbanBoard[]>;
    query(boardId: string, query?: KanbanItemQuery): Promise<KanbanItemPage>;
    item(boardId: string, itemId: string): Promise<{item: KanbanItem; task?: import('./task-state').KanbanTaskProjection; archive?: Omit<KanbanArchivedItem, 'item'>}>;
    overview(boardId: string): Promise<KanbanOverview>;
    scan(): Promise<void>;
}

export type KanbanBoardInput = Pick<KanbanBoard, 'id' | 'scope' | 'title' | 'agents' | 'members' | 'workTypes' | 'defaultWorkType' | 'columns' | 'notifications'> & {policy?: Partial<KanbanPolicy>};
