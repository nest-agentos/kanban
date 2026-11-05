/** Transport-neutral durable execution data. Requests and results belong to the adapter. */
export interface KanbanOperationRecord {
    id:string;boardId:string;itemId:string;action:string;fingerprint:string;
    phase:'prepared'|'submitting'|'settled';state:'running'|'unknown'|'succeeded'|'failed';
    createdAt:number;sessionId?:string;code?:string;result?:unknown;
}
export interface KanbanOperationObservation {
    state:'running'|'unknown'|'succeeded'|'failed';executionId?:string;code?:string;output?:unknown;
}
/** Only an authoritative no-start receipt permits submitting the frozen request again. */
export interface KanbanOperationFailure {
    code:string;disposition:'retry-unstarted'|'terminal'|'unknown';result?:unknown;
}
export interface KanbanOperationPort<T extends KanbanOperationRecord> {
    start(record:T):Promise<void>;
    inspect(record:T):Promise<KanbanOperationObservation>;
    validate?(record:T,output:unknown):Promise<void>|void;
    classify?(error:unknown):KanbanOperationFailure;
    report?(record:T):Promise<void>;
}
