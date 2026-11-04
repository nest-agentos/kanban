import type {KanbanAnalysisStatus} from './automation';
import type {KanbanPlanning} from './planning';
import type {KanbanExternalReference, KanbanPrincipal} from './configuration';

export interface KanbanLaunch {
    mode?: 'automatic' | 'manual';
    startAt: number; analysisEpoch?: string; requestedAt?: number; admittedAt?: number;
    editing?: {id: string; principal: KanbanPrincipal; expiresAt: number};
}
export interface KanbanTaskControl {
    id: string; dispatchId?: string; action: 'pause' | 'resume';
    state: 'requested' | 'accepted' | 'paused' | 'resumed' | 'failed' | 'unknown'; code?: string;
}
export interface KanbanTaskIssue {id: string; attemptId: string; type: 'clarification' | 'error'; resolvedBy?: string}
export type KanbanTaskPhase = 'waiting-start' | 'analyzing' | 'queued' | 'waiting-dependency' | 'preparing' | 'running'
    | 'pausing' | 'paused' | 'resuming' | 'waiting-input' | 'error' | 'review' | 'completed' | 'cancelled' | 'unknown';
export interface KanbanTaskProjection {
    phase: KanbanTaskPhase; reason?: string; startAt?: number; sessionId?: string; dispatchId?: string;
    actions: Array<'run' | 'edit' | 'cancel' | 'pause' | 'resume' | 'fix' | 'open-session' | 'resolve' | 'review'>;
}
export type KanbanTaskCommand =
    | {type: 'begin-edit'; itemId: string; editId: string; leaseMs: number}
    | {type: 'end-edit'; itemId: string; editId: string}
    | {type: 'save-edit'; itemId: string; editId: string; title: string; responsibility: string; acceptance: string; planning: KanbanPlanning; launchMode?: 'automatic' | 'manual'; externalRefs?: KanbanExternalReference[]}
    | {type: 'retry-analysis'; itemId: string; retryId: string}
    | {type: 'set-launch-mode'; itemId: string; mode: 'automatic' | 'manual'}
    | {type: 'request-run'; itemId: string}
    | {type: 'admit-item'; itemId: string; trigger: 'manual' | 'automatic'}
    | {type: 'report-analysis'; itemId: string; operationId: string; status: KanbanAnalysisStatus}
    | {type: 'request-control'; itemId: string; controlId: string; action: 'pause' | 'resume'}
    | {type: 'control-receipt'; itemId: string; controlId: string; state: KanbanTaskControl['state']; code?: string}
    | {type: 'report-issue'; itemId: string; issue: KanbanTaskIssue}
    | {type: 'resolve-issue'; itemId: string; issueId: string; attemptId: string; resolvedBy: string};

export interface KanbanFixSession {id:string;boardId:string;itemId:string;sessionId:string;state:'clarifying'|'frozen'|'accepted';createdItemId?:string}
