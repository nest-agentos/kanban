import {deliveryKey,reportDelivery} from './automatic-delivery-state';
import {safeCode} from './diagnostics';
import type {AutomaticDeliveryOptions as Options,AutomaticDeliveryState as State} from './automatic-delivery-types';
import {jobKey} from './delivery-policy';
const key=(state:State)=>deliveryKey(state.boardId,state.itemId,state.scopeId);

/** Archive stale requests; their receipts remain immutable and unknown effects never restart. */
export async function refreshAutomaticAnalysis(options:Options,state:State,steps:string[]):Promise<State|undefined> {
    const action=steps[state.step],index=steps.indexOf(options.policy.refreshAction);
    if(state.manualAfter||index<0||!options.policy.refreshableActions.includes(action)||state.code&&!options.policy.refreshCodes.includes(state.code)||!options.active())return;
    const started=Date.now(),proof=await options.reanalysis?.(state.boardId,state.itemId,state.requests[action]?.operationId);if(!proof)return;
    if(state.revisionEpoch===proof.revision)return state;
    await options.journal.update('automatic-reanalysis-history:'+state.id+':'+proof.revision,old=>old??state);
    const next=await options.journal.update<State>(key(state),old=>{
        if(!old||old.revisionEpoch===proof.revision||old.step!==state.step||old.requests[action]?.operationId!==state.requests[action]?.operationId)return old!;
        const requests=Object.fromEntries(Object.entries(old.requests).filter(([name])=>steps.indexOf(name)>=0&&steps.indexOf(name)<index));
        return {...old,step:index,revisionEpoch:proof.revision,requests,code:undefined,reportedBoundary:undefined,cleanupPrecondition:undefined};
    });
    options.journal.diagnostic({operationId:state.id,boardId:state.boardId,itemId:state.itemId,stage:'automatic.analysis.refresh',result:'success',durationMs:Date.now()-started});
    return next;
}

export async function recordAutomaticFailure(options:Options,state:State,error:unknown,steps:string[]):Promise<void> {
    if(!options.active())return;
    state=await options.journal.get<State>(key(state))??state;
    let code=safeCode(error,'AUTOMATIC_DELIVERY_FAILED');if(code==='AUTOMATIC_DELIVERY_PAUSED')return;
    const action=steps[state.step],request=state.requests[action];
    if(action===options.policy.refreshAction&&request&&options.policy.unstartedCodes.includes(code)&&!await options.journal.get(jobKey(request.operationId))){
        const view=await options.view(state.boardId,state.itemId);
        await options.journal.update<State>(key(state),old=>({...old!,code:undefined,requests:{...old!.requests,[action]:{...request,expectedRevision:view.revision}}}));return;
    }
    const cleanupPrecondition=action===options.policy.finalizeAction&&(error as {cleanupPrecondition?:boolean})?.cleanupPrecondition===true;
    if(state.code===code&&state.cleanupPrecondition===cleanupPrecondition)return;
    state=await options.journal.update<State>(key(state),old=>({...old!,code,cleanupPrecondition}));
    if(options.policy.refreshCodes.includes(code)){
        try{if(await refreshAutomaticAnalysis(options,state,steps))return;}
        catch(cause){code=safeCode(cause,'AUTOMATIC_REANALYSIS_FAILED');state=await options.journal.update<State>(key(state),old=>({...old!,code}));}
    }
    await reportDelivery(options,state);
}
