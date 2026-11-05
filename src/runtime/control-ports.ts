import type {KanbanReferencePolicy} from './ports';
export type KanbanControlState='accepted'|'paused'|'resumed'|'cancelled'|'unknown';
export interface KanbanControlRequest {
    executionId:string;operationId:string;action:'pause'|'resume'|'cancel';attemptId?:string;
    kind?:'call'|'submission';prepared?:unknown;previousKey?:string;fallbackSubmission?:boolean;
}
export interface KanbanExecutionControlPort {
    control(request:KanbanControlRequest):Promise<KanbanControlState>;
    inspect?(executionId:string,attemptId?:string):Promise<{settled:boolean;outcome?:'succeeded'|'failed'|'cancelled'}|undefined>;
}
export interface KanbanTaskControlOptions {control:KanbanExecutionControlPort;references?:KanbanReferencePolicy;finalizerPrefix?:string}
