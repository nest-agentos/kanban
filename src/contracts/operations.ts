import type {KanbanExternalReference} from './configuration';
export interface KanbanOperationChoice {id: string; label: string; detail?: string}
export interface KanbanOperationField {id: string; label: string; choices: KanbanOperationChoice[]; selected?: string}
/** Host-owned operations; the portable view does not interpret deployment or Git policy. */
export interface KanbanItemOperation {
    id: string; label: string; state: 'unavailable' | 'ready' | 'running' | 'unknown' | 'succeeded' | 'failed' | 'waiting-confirmation';
    runLabel?:string; hideRun?:boolean; followUp?:{action:string;label:string;confirmation:string};
    enabled: boolean; code?: string; reason?: string; runId?: string; sessionId?: string;
    summary?: string; fields?: KanbanOperationField[]; confirmation?: string;
    configurable?: boolean; binding?: KanbanExternalReference;
    openSessionOnRun?: boolean;
}
export interface KanbanItemOperations {
    automatic?:{state:'running'|'blocked'|'completed';stage:string;code?:string;waitingForTarget?:boolean};
    revision: string; operations: KanbanItemOperation[];
    targets?: Array<{label: string; reference: KanbanExternalReference}>;
}
export interface KanbanItemOperationRequest {
    operationId: string; itemId: string; action: string; expectedRevision: string;
    selections?: Record<string, string>; confirmed?: boolean; followUp?:string;
}
export interface KanbanItemOperationBinding {
    operationId: string; itemId: string; action: string; expectedRevision: string; target: KanbanExternalReference;
}
