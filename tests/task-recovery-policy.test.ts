import {expect,it} from 'vitest';
import type {KanbanItem,KanbanDispatch} from '../src/contracts';
import {taskRecoveryEligibility,activeRecoveryIssueIds} from '../src/runtime/task-recovery-policy';
const item={id:'item',status:'open'} as KanbanItem,dispatch={id:'attempt',outcome:'failed'} as KanbanDispatch;
const evidence={resourcesRetained:true,blockingItemIds:[],targetReady:true,currentTargetSelectable:false};
it('requires terminal execution and positive resource, dependency and host target evidence',()=>{
    expect(taskRecoveryEligibility(item,dispatch,evidence)).toEqual({canRetry:true,canSelectCurrentVersion:false});
    for(const outcome of ['prepared','running','unknown','succeeded'])expect(taskRecoveryEligibility(item,{...dispatch,outcome} as KanbanDispatch,evidence).canRetry).toBe(false);
    for(const change of [{resourcesRetained:false},{blockingItemIds:['repair']},{targetReady:false}])expect(taskRecoveryEligibility(item,dispatch,{...evidence,...change}).canRetry).toBe(false);
    expect(taskRecoveryEligibility({...item,control:{action:'cancel'} as never},dispatch,evidence).canRetry).toBe(false);
});
it('projects only unresolved issues belonging to the current active attempt',()=>{
    const value={...item,issues:[{id:'old',attemptId:'old'},{id:'current',attemptId:'attempt'},{id:'resolved',attemptId:'attempt',resolvedBy:'reply'}]} as KanbanItem;
    expect(activeRecoveryIssueIds(value,{...dispatch,outcome:'running'})).toEqual(['current']);expect(activeRecoveryIssueIds(value,dispatch)).toEqual([]);
});

it('follows a failed continuation only within its original item and generation',async()=>{
    const {findRetainedExecution}=await import('../src/runtime/task-recovery-policy');
    const old={id:'old',itemId:'item',executionEpoch:'generation',outcome:'failed'} as KanbanDispatch;
    const next={...old,id:'next',continuation:{previousDispatchId:'old'}} as KanbanDispatch;
    const workflow={dispatches:{old,next}} as never,inspect=async(row:KanbanDispatch)=>row.id==='old'?{resource:'retained'}:undefined;
    expect(await findRetainedExecution(workflow,next,inspect)).toMatchObject({dispatch:{id:'old'},resource:{resource:'retained'}});
    for(const change of [{itemId:'other'},{executionEpoch:'other'}])expect(await findRetainedExecution({dispatches:{old:{...old,...change},next}} as never,next,inspect)).toBeUndefined();
    expect(await findRetainedExecution(workflow,{...next,outcome:'unknown'},inspect)).toBeUndefined();
});
it('rejects planning results once their source decision has changed or been cancelled',async()=>{
    const {validateDecisionSource}=await import('../src/runtime/task-recovery-policy');const snapshot={title:'Research',content:'Original',rationale:'Evidence',externalRefs:[]};
    const source={sourceBoardId:'b',recordId:'decision',snapshot};
    await validateDecisionSource({record:async()=>({...snapshot,status:'confirmed'})} as never,source);
    for(const change of [{content:'Changed'},{status:'cancelled'}])await expect(validateDecisionSource({record:async()=>({...snapshot,status:'confirmed',...change})} as never,source)).rejects.toMatchObject({code:'PLANNING_DECISION_STALE'});
});
