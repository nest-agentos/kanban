export interface KanbanReportUsage {
    files:number;bytes:number;maxFiles:number;maxBytes:number;directories:Array<{path:string;files:number;bytes:number}>;
}
export interface KanbanRecoveryReceipt {
    operationId:string;state:'pending'|'accepted'|'blocked';checkedAt:number;code?:string;
}
export interface KanbanTaskConfigurationStatus {
    currentRevision:string;notifiedRevision?:string;readRevision?:string;state:'none'|'queued'|'dispatched'|'read';
}
export interface KanbanTaskRecovery {
    reportReceipt?:KanbanRecoveryReceipt;
    reportHandoff?:{code:string;canRecheck:boolean;reportResourceId?:string;receipt?:KanbanRecoveryReceipt};
    state?:'blocked';pendingIssueIds?:string[];
    revision:string;itemId:string;code?:string;expectedVersion?:string;actualVersion?:string;
    sessionId?:string;resourceId?:string;canRetry:boolean;canRecheck?:boolean;canSelectCurrentVersion:boolean;
    deliveryOperationId?:string;deliveryItemId?:string;blockingItems?:Array<{id:string;title:string}>;
    related:Array<{itemId:string;title:string;number?:number;resourceId?:string}>;
}
export interface KanbanTaskRecoveryRequest {
    operationId:string;itemId:string;expectedRevision:string;action:'retry'|'retry-current'|'fix'|'recheck'|'reconcile-report';sourceItemId?:string;confirmed?:boolean;
}
export interface KanbanTaskRecoveryResult {operationId:string;state:'pending'|'accepted'|'blocked';code?:string;missing?:string[];dispatchId?:string;resourceId?:string}
