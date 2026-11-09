import type {KanbanExternalReference} from './configuration';
export interface KanbanOperationChoice {id: string; label: string; detail?: string}
export interface KanbanOperationField {id: string; label: string; choices: KanbanOperationChoice[]; selected?: string}
/** Host-owned operations; the portable view does not interpret deployment or Git policy. */
export interface KanbanItemOperation {
    id: string; label: string; state: 'unavailable' | 'ready' | 'running' | 'unknown' | 'succeeded' | 'failed' | 'waiting-confirmation' | 'skipped' | 'cancelling' | 'cancelled';
    cancel?: {runId:string;enabled:boolean;operationId?:string;state?:'requested'|'accepted'|'unknown'|'cancelled'|'failed'|'not-required';reason?:string;code?:string;requestedAt?:number};
    progress?: {stage:'preparing'|'waiting-context'|'running'|'reconciling'|'queued'|'cancelling';label:string;requestedAt?:number};
    dependsOn?: string[]; skip?: {affected: Array<{id:string;label:string}>};
    waiver?: {id:string;cause:'direct'|'dependency';action:string;reason:string;at:number;actor:import('./contracts').KanbanActor};
    runLabel?:string; hideRun?:boolean; followUp?:{action:string;label:string;confirmation:string};
    enabled: boolean; code?: string; reason?: string; runId?: string; sessionId?: string;
    summary?: string; fields?: KanbanOperationField[]; confirmation?: string;
    configurable?: boolean; binding?: KanbanExternalReference;
    openSessionOnRun?: boolean;
}
export interface KanbanItemOperations {
    automatic?:{state:'running'|'blocked'|'completed'|'waiting-confirmation';stage:string;code?:string;waitingForTarget?:boolean;waitingForUser?:boolean};
    halted?: {runId:string;state:'cancelling'|'cancelled'};
    waivers?: import('./operation-waiver').KanbanOperationWaiver[];
    waiverHistory?: import('./operation-waiver').KanbanOperationWaiver[];
    acceptance?: import('./operation-waiver').KanbanAcceptanceResult;
    skippedActions?: string[];
    revision: string; operations: KanbanItemOperation[];
    targets?: Array<{label: string; reference: KanbanExternalReference}>;
}
export interface KanbanItemOperationRequest {
    operationId: string; itemId: string; action: string; expectedRevision: string;
    cancel?: {runId:string};
    skip?: {action:string;reason:string;affected:string[]};
    selections?: Record<string, string>; confirmed?: boolean; followUp?:string;
}
export interface KanbanItemOperationBinding {
    operationId: string; itemId: string; action: string; expectedRevision: string; target: KanbanExternalReference;
}
