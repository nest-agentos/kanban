import type {KanbanService} from './contracts';
import type {KanbanItemPage, KanbanItemQuery, KanbanItemSummary} from './planning';
export type KanbanSessionPhase = 'running' | 'queued' | 'waiting' | 'waiting-input' | 'waiting-approval' | 'paused' | 'idle' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export interface KanbanExecutionSession {
    sessionId: string; resourceId?:string; title?: string; state: KanbanSessionPhase;
    createdAt?: number;
    lastActivityAt?: number; observedAt?: number; stale: boolean; recent: boolean; code?: string;
}
export interface KanbanPlanningSession extends KanbanExecutionSession {itemId: string; analysisId: string}
export interface KanbanSessionActivityQuery extends KanbanItemQuery {execution?: 'all' | 'running' | 'recent' | 'active'}
export interface KanbanSessionItemSummary extends KanbanItemSummary {execution?: KanbanExecutionSession}
export interface KanbanSessionItemPage extends Omit<KanbanItemPage,'items'> {items: KanbanSessionItemSummary[]}
export type KanbanSessionPurpose = 'execution' | 'planning' | 'fix' | 'finalization' | 'discussion';
/** A run belongs to a Session; continuing it does not create another Session. */
export interface KanbanSessionExecution {
    id: string; purpose: KanbanSessionPurpose; dispatchId?: string; attempt?: number;
    previousDispatchId?: string; roundId?: string; turnId?: string;
    state?: KanbanSessionPhase; outcome?: import('./workflow').KanbanDispatch['outcome'];
    createdAt?: number; completedAt?: number; code?: string;
    resources?: Array<{label: string; value: string}>;
}
export interface KanbanSessionAssociation {sessionId: string; purpose: KanbanSessionPurpose; execution?: KanbanSessionExecution}
export interface KanbanRelatedSession extends KanbanExecutionSession {
    current: boolean; purposes: KanbanSessionPurpose[]; executions: KanbanSessionExecution[];
}
export interface KanbanSessionDetailQuery {includeRelated?: boolean}
export interface KanbanExecutionSessionDetail {
    continuation?: {previousDispatchId: string};
    current?: KanbanExecutionSession;
    history: Array<{sessionId: string; bindingId?: string; current: boolean}>;
    /** Loaded explicitly so activity polling never enumerates historical Sessions. */
    sessions?: KanbanRelatedSession[];
    sessionsCode?: string;
}

/** Transport-facing service with optional authorized resource activity. */
export interface KanbanClient extends KanbanService {
    cancelBoard?(boardId: string, request: {operationId:string; expectedRevision:number}): Promise<void>;
    requestBoardDeletion?(boardId:string, request:import('./deletion').KanbanDeletionRequest & {mode:'drain'|'cancel'}):Promise<void>;
    previewDeletion?(boardId: string): Promise<import('./deletion').KanbanDeletionPreview>;
    deleteBoard?(boardId: string, request: import('./deletion').KanbanDeletionRequest): Promise<void>;
    itemOperations?(boardId: string, itemId: string): Promise<import('./operations').KanbanItemOperations>;
    runItemOperation?(boardId: string, request: import('./operations').KanbanItemOperationRequest): Promise<import('./operations').KanbanItemOperations>;
    bindItemOperation?(boardId: string, request: import('./operations').KanbanItemOperationBinding): Promise<import('./operations').KanbanItemOperations>;
    workResources?(boardId: string, itemId: string, query?: import('./work-resources').KanbanWorkResourceQuery): Promise<import('./work-resources').KanbanWorkResource[]>;
    cleanupWorkResource?(boardId: string, request: import('./work-resources').KanbanWorkResourceCleanup): Promise<import('./work-resources').KanbanWorkResource>;
    replyTask?(boardId:string,request:{itemId:string;attemptId:string;replyTo:string;operationId:string;content:string}):Promise<void>;
    taskFixes?(boardId: string, itemId: string): Promise<import('./task-state').KanbanFixSession[]>;
    cancelFix?(boardId: string, request: {fixId: string; operationId: string}): Promise<import('./task-state').KanbanFixSession>;
    controlRecord?(boardId: string, request: {recordId: string; operationId: string; action: 'pause' | 'resume' | 'cancel'}): Promise<void>;
    fixTask?(boardId:string,request:{itemId:string;operationId:string}):Promise<import('./task-state').KanbanFixSession>;
    itemResources?(boardId:string,parentId?:string):Promise<import('./record-execution').KanbanItemResourceCatalog>;
    recordResources?(): Promise<import('./record-execution').KanbanRecordResource[]>;
    runRecord?(boardId: string, request: import('./record-execution').KanbanRecordRunRequest): Promise<import('./record-execution').KanbanRecordExecution>;
    planningSession?(boardId: string, itemId: string): Promise<KanbanPlanningSession | undefined>;
    recordSessions?(boardId: string, recordId: string): Promise<KanbanPlanningSession[]>;
    recordExecutions?(boardId: string, recordId: string): Promise<import('./record-execution').KanbanRecordExecution[]>;
    automationCatalog?(): Promise<import('./automation').KanbanAutomationCatalog>;
    analysisStatus?(boardId: string, itemId: string): Promise<import('./automation').KanbanAnalysisStatus | null>;
    queryActivity?(boardId: string, query?: KanbanSessionActivityQuery): Promise<KanbanSessionItemPage>;
    executionSession?(boardId: string, itemId: string, query?: KanbanSessionDetailQuery): Promise<KanbanExecutionSessionDetail>;
}
