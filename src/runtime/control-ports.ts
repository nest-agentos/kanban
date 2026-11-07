import type {KanbanReferencePolicy} from './ports';
export type KanbanControlState='accepted'|'paused'|'resumed'|'cancelled'|'unknown';
export interface KanbanControlRequest {
    observationSessionId?:string;executionId:string;operationId:string;action:'pause'|'resume'|'cancel';attemptId?:string;
    kind?:'call'|'submission'|'conversation';prepared?:unknown;previousKey?:string;fallbackSubmission?:boolean;
}
export interface KanbanExecutionControlPort {
    control(request:KanbanControlRequest):Promise<KanbanControlState>;
    inspect?(executionId:string,attemptId?:string):Promise<{settled:boolean;outcome?:'succeeded'|'failed'|'cancelled'}|undefined>;
}
export interface KanbanTaskControlOptions {beforeCancel?(boardId:string,itemId:string,operationId:string):Promise<KanbanControlState>;control:KanbanExecutionControlPort;references?:KanbanReferencePolicy;finalizerPrefix?:string}
