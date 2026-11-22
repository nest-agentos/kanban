import type {KanbanExternalReference} from './configuration';
export interface KanbanOperationChoice {id: string; label: string; detail?: string}
export interface KanbanOperationField {id: string; label: string; choices: KanbanOperationChoice[]; selected?: string}
/** Host-owned operations; the portable view does not interpret deployment or Git policy. */
export interface KanbanOperationAttention {kind:'choice'|'authorization'|'recovery'}
export interface KanbanOperationFact {
    id:string;state:'unavailable'|'ready'|'running'|'unknown'|'succeeded'|'failed'|'waiting-confirmation'|'skipped'|'cancelling'|'cancelled';
    code?:string;runId?:string;sessionId?:string;
}
export interface KanbanItemOperation extends KanbanOperationFact {
    group?: {id:string;label:string};
    label:string;
    cancel?: {affected?:Array<{id:string;label:string;group?:{id:string;label:string}}>;runId:string;enabled:boolean;operationId?:string;state?:'requested'|'accepted'|'unknown'|'cancelled'|'failed'|'not-required';reason?:string;code?:string;requestedAt?:number};
    progress?: {stage:'preparing'|'waiting-context'|'running'|'reconciling'|'queued'|'cancelling';label:string;requestedAt?:number};
    dependsOn?: string[]; skip?: {affected: Array<{id:string;label:string;group?:{id:string;label:string}}>};
    waiver?: {id:string;cause:'direct'|'dependency';action:string;reason:string;at:number;actor:import('./contracts').KanbanActor};
    runAction?:string; runLabel?:string; hideRun?:boolean; followUp?:{action:string;label:string;confirmation:string};
    enabled:boolean;reason?:string;attention?:KanbanOperationAttention;
    recovery?: {runId:string;label:string;reason:string;prompt?:string};
    inspectWorkResources?: boolean;
    statusText?:string; summary?: string; fields?: KanbanOperationField[]; confirmation?: string;
    configurable?: boolean; binding?: KanbanExternalReference;
    openSessionOnRun?: boolean;
}
export interface KanbanItemOperations {
    /** Settled or uncertain persisted attempts retained for an archived owner. */
    history?:KanbanItemOperation[];
    pluginId?:string;
    plugins?:Array<{id:string;version:string;label:string;view:KanbanItemOperations}>;
    code?:string;
    /** Host-owned operation scopes share the same task owner and retain independent receipts. */
    scopes?:Array<{id:string;label:string;contributors:Array<{itemId:string;title:string}>;view:KanbanItemOperations}>;
    owner?:{boardId:string;itemId:string};
    automatic?:{attention?:KanbanOperationAttention;state:'running'|'blocked'|'completed'|'waiting-confirmation';stage:string;code?:string;waitingForTarget?:boolean;waitingForUser?:boolean};
    halted?: {runId:string;state:'cancelling'|'cancelled'};
    waivers?: import('./operation-waiver').KanbanOperationWaiver[];
    waiverHistory?: import('./operation-waiver').KanbanOperationWaiver[];
    acceptance?: import('./operation-waiver').KanbanAcceptanceResult;
    skippedActions?: string[];
    revision: string; operations: KanbanItemOperation[];
    targets?: Array<{label: string; reference: KanbanExternalReference}>;
}
export interface KanbanItemOperationRequest {
    pluginId?:string;
    scopeId?:string;
    operationId: string; itemId: string; action: string; expectedRevision: string;
    cancel?: {runId:string};
    reconcile?: {runId:string};
    skip?: {action:string;reason:string;affected:string[]};
    selections?: Record<string, string>; confirmed?: boolean; followUp?:string;
}
export interface KanbanItemOperationBinding {
    pluginId?:string;
    scopeId?:string;
    operationId: string; itemId: string; action: string; expectedRevision: string; target: KanbanExternalReference;
}
/** Plugins own action identity and presentation; the board never interprets action names. */
export interface KanbanOperationPluginDescriptor {
    id:string;version:string;label:string;
    actions:Array<{id:string;label:string;dependsOn?:string[];coordination?:boolean}>;
}
