import {requireValue} from '../rules';
import type {KanbanItem,KanbanDispatch,KanbanWorkflowState,KanbanService,KanbanProjectRecord} from '../contracts';
export interface KanbanRecoveryEvidence {resourcesRetained:boolean;blockingItemIds:readonly string[];targetReady:boolean;currentTargetSelectable:boolean}
/** Execution and version observations remain host-owned; only positive evidence admits a retry. */
export function taskRecoveryEligibility(item:KanbanItem,dispatch:KanbanDispatch|undefined,evidence:KanbanRecoveryEvidence):{canRetry:boolean;canSelectCurrentVersion:boolean}{
    const terminal=!!dispatch&&['failed','cancelled','rejected'].includes(dispatch.outcome)&&['backlog','open'].includes(item.status)&&item.control?.action!=='cancel';
    const eligible=terminal&&evidence.resourcesRetained&&evidence.blockingItemIds.length===0;
    return {canRetry:eligible&&evidence.targetReady,canSelectCurrentVersion:eligible&&evidence.currentTargetSelectable};
}
export function activeRecoveryIssueIds(item:KanbanItem,dispatch:KanbanDispatch|undefined):string[]{
    if(!dispatch||!['prepared','running'].includes(dispatch.outcome)||item.control?.action==='cancel')return [];
    return item.issues?.filter(issue=>!issue.resolvedBy&&issue.attemptId===dispatch.id).map(issue=>issue.id)??[];
}

/** Continuations may reuse only the same item and execution generation. */
export async function findRetainedExecution<T>(workflow:KanbanWorkflowState,dispatch:KanbanDispatch|undefined,inspect:(candidate:KanbanDispatch)=>Promise<T|undefined>):Promise<{dispatch:KanbanDispatch;resource:T}|undefined>{
    let current=dispatch;const seen=new Set<string>();
    while(current&&!seen.has(current.id)){
        seen.add(current.id);const resource=await inspect(current);if(resource!==undefined)return {dispatch:current,resource};
        const previous=current.continuation?workflow.dispatches[current.continuation.previousDispatchId]:undefined;
        if(current.outcome!=='failed'||!previous||previous.itemId!==dispatch!.itemId||previous.executionEpoch!==dispatch!.executionEpoch)return;
        current=previous;
    }
}
export async function validateDecisionSource(service:Pick<KanbanService,'record'>,source:{sourceBoardId:string;recordId:string;snapshot?:unknown}|null):Promise<void>{
    if(!source)return;
    const current=await service.record(source.sourceBoardId,source.recordId),snapshot=source.snapshot as KanbanProjectRecord|undefined;
    const definition=(record:KanbanProjectRecord)=>JSON.stringify([record.title,record.content,record.rationale,record.externalRefs]);
    requireValue(current.status==='confirmed'&&snapshot&&definition(current)===definition(snapshot),'PLANNING_DECISION_STALE');
}
