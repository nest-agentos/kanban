export interface KanbanTaskRecovery {
    revision:string;itemId:string;code?:string;expectedVersion?:string;actualVersion?:string;
    sessionId?:string;resourceId?:string;canRetry:boolean;canSelectCurrentVersion:boolean;
    deliveryOperationId?:string;deliveryItemId?:string;blockingItems?:Array<{id:string;title:string}>;
    related:Array<{itemId:string;title:string;number?:number;resourceId?:string}>;
}
export interface KanbanTaskRecoveryRequest {
    operationId:string;itemId:string;expectedRevision:string;action:'retry'|'retry-current'|'fix';sourceItemId?:string;confirmed?:boolean;
}
export interface KanbanTaskRecoveryResult {operationId:string;state:'pending'|'accepted';code?:string;dispatchId?:string;resourceId?:string}
