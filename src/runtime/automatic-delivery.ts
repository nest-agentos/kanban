import {deliveryKey as key,deliverySteps as actions,deliveryComplete as settledDelivery,deliveryStatus,reportDelivery} from './automatic-delivery-state';
import type {AutomaticDeliveryState as State,AutomaticDeliveryOptions as Options} from './automatic-delivery-types';
import {refreshAutomaticAnalysis,recordAutomaticFailure} from './automatic-reanalysis';
import {selectDeliverySteps} from './delivery-policy';
import type {KanbanWorkResource} from '../contracts';
import {claimDeliveryTarget,releaseDeliveryTarget} from './automatic-delivery-target';
import {sha256HexSync} from '../utils';
import type {KanbanBoard,KanbanItem,KanbanItemOperations,KanbanService,KanbanWorkflowState} from '../contracts';
import {type KanbanAutomationJournal} from './automation-journal';
async function admitted(options:Options,state:State) {
    if(!options.active())return false;
    const board=await options.service.read(state.boardId),item=board.items.find(row=>row.id===state.itemId);
    return options.active()&&!!board.automation?.enabled&&!board.executionControl?.paused&&!board.lifecycle&&!!item&&!item.deletedAt&&item.status!=='cancelled'&&item.control?.action!=='cancel'&&(!!options.scopeId||['review','completed'].includes(item.status));
}
/** Explicitly retained resources settle finalization without fabricating cleanup receipts. */
export async function settleWorkspaceFinalization(options:{service:KanbanService;journal:KanbanAutomationJournal;finalizeAction:string},board:string,item:string,resources:KanbanWorkResource[]):Promise<void> {
    if(!resources.length||!resources.every(row=>row.state==='cleaned'||row.resolution?.kind==='ignored'))return;
    const state=await options.journal.get<State>(key(board,item));
    if(!state||settledDelivery(state)||actions(state)[state.step]!==options.finalizeAction)return;
    const settled=await options.journal.update<State>(key(board,item),current=>current&&!settledDelivery(current)&&actions(current)[current.step]===options.finalizeAction?{...current,step:actions(current).length,code:undefined,cleanupPrecondition:undefined}:current!);
    if(settledDelivery(settled))await releaseDeliveryTarget(options,settled);
}
/** Frozen identities survive restart; unknown effects are observed rather than retried. */
export function automaticDelivery(options:Options) {
    return {ready:async(boardId:string,item:KanbanItem)=>{
        if(!options.automatic||!await options.automatic(await options.service.read(boardId),item))return true;
        return settledDelivery(await options.journal.get<State>(key(boardId,item.id,options.scopeId)));
    },scanScope:async(boardId:string,itemId:string)=>{
        if(!options.automatic)return;
        const board=await options.service.read(boardId);if(!await options.automatic(board,(await options.service.item(boardId,itemId)).item))return;
        const item=board.items.find(row=>row.id===itemId);
        if(!board.automation?.enabled||board.executionControl?.paused||board.lifecycle||!item||item.deletedAt||item.control?.action==='cancel')return;
        if(options.scopeId&&item.status!=='cancelled')await scanItem(options,board,item,await options.service.workflow(boardId));
    },scan:async()=>{
        if(!options.automatic)return;
        for(const entry of await options.service.catalog()) {
            if(!options.active())return;
            await scanBoard(options,await options.service.read(entry.id));
        }
    }};
}
async function scanBoard(options:Options,board:KanbanBoard) {
    if(!board.automation?.enabled||board.executionControl?.paused||board.lifecycle)return;
    const workflow=await options.service.workflow(board.id);
    for(const item of board.items) {
        if(!options.active())return;
        if(item.deletedAt||item.control?.action==='cancel'||!['review','completed'].includes(item.status))continue;
        if(await options.automatic!(board,item))await scanItem(options,board,item,workflow);
    }
}
async function prepareState(options:Options,board:KanbanBoard,item:KanbanItem,workflow:KanbanWorkflowState) {
    const group=item.planning?.execution==='children';if(group&&!options.scopeId&&item.status!=='completed')return;
    const dispatch=Object.values(workflow.dispatches).filter(row=>row.itemId===item.id).sort((a,b)=>b.attempt-a.attempt)[0];
    if(!group&&(!dispatch||!['succeeded','accepted'].includes(dispatch.outcome)))return;
    const id='auto-'+sha256HexSync(JSON.stringify([board.id,item.id,dispatch?.id??item.externalRefs?.find(ref=>ref.system==='nestos-decision-run')?.id,...options.scopeId?[options.scopeId]:[]])).slice(0,48);
    const target=options.target?.(board,item),plan=group&&!options.scopeId?undefined:await options.plan?.(board,item),selected=selectDeliverySteps(group&&!options.scopeId?[options.policy.finalizeAction]:plan?.steps??options.policy.steps,options.policy.steps,plan?.ordering);
    const previous=await options.journal.get<State>(key(board.id,item.id,options.scopeId)),executionId=dispatch?.id??item.id;
    if(previous&&previous.executionId!==executionId){await options.journal.update('automatic-delivery-history:'+previous.id,old=>old??previous);await releaseDeliveryTarget(options,previous);}
    return options.journal.update<State>(key(board.id,item.id,options.scopeId),old=>{
        if(old?.executionId!==executionId)return {id,target,ordering:plan?.ordering,scopeId:options.scopeId,boardId:board.id,itemId:item.id,executionId,step:0,steps:selected,manualAfter:plan?.manualAfter,manualOrder:plan?.steps,requests:{}};
        const ordered=selectDeliverySteps(old.steps??options.policy.steps,options.policy.steps,old.ordering),changed=JSON.stringify(ordered)!==JSON.stringify(old.steps??options.policy.steps);
        return {...old,...(!old.target&&target?{target}:{}),...(!old.steps||changed?{steps:ordered,...(changed?{step:0}:{})}: {})};
    });
}
async function scanItem(options:Options,board:KanbanBoard,item:KanbanItem,workflow:KanbanWorkflowState) {
    let state=await prepareState(options,board,item,workflow);if(!state)return;
    if(state.handoff)return;
    const owner=await options.handoff?.(board,item);
    if(owner){await handoffDelivery(options,state,owner);return;}
    if(settledDelivery(state)){if(settledDelivery(state))await releaseDeliveryTarget(options,state);return;}
    if(state.code==='OPERATION_CANCELLED'&&(await options.view(state.boardId,state.itemId)).halted){await releaseDeliveryTarget(options,state);return;}
    if(state.manualAfter&&state.step>actions(state).indexOf(state.manualAfter))await releaseDeliveryTarget(options,state);
    else if(!await claimDeliveryTarget(options,state)){if(!state.waitingForTarget)await options.journal.update<State>(key(board.id,item.id,options.scopeId),old=>({...old!,waitingForTarget:true}));return;}
    if(state.waitingForTarget)state=await options.journal.update<State>(key(board.id,item.id,options.scopeId),old=>({...old!,waitingForTarget:false}));
    try {
        state=await refreshAutomaticAnalysis(options,state,actions(state))??state;
        if(state.code&&!(actions(state)[state.step]===options.policy.finalizeAction&&state.cleanupPrecondition)){state=await resumeConfirmedOperation(options,state);if(state.code)return;}
        const manualOrder=state.manualAfter?(await options.plan?.(board,item))?.steps:undefined;
        await advance(options,state,manualOrder);
        if(settledDelivery(await options.journal.get<State>(key(board.id,item.id,options.scopeId))))await releaseDeliveryTarget(options,state);
    }catch(error){await recordAutomaticFailure(options,state,error,actions(state));}
}
async function handoffDelivery(options:Options,state:State,owner:{boardId:string;itemId:string}):Promise<void> {
    await options.settle?.(state.boardId,state.itemId);
    const {item}=await options.service.item(state.boardId,state.itemId);
    if(item.status==='completed'){
        await options.journal.update('automatic-handoff-history:'+state.id,old=>old??state);
        const next=await options.journal.update<State>(key(state.boardId,state.itemId,state.scopeId),old=>({...old!,handoff:{...owner,at:Date.now()},code:undefined,waitingForTarget:false}));
        await releaseDeliveryTarget(options,next);await reportDelivery(options,next);return;
    }
    const view=await options.view(state.boardId,state.itemId),accept=view.operations.find(row=>row.id===options.policy.handoffAction);
    if(!accept?.enabled||view.operations.some(row=>!!row.progress))return;
    const operationId='handoff-'+sha256HexSync(state.id).slice(0,48);
    await options.run(state.boardId,{operationId,itemId:state.itemId,action:options.policy.handoffAction,expectedRevision:view.revision});
}
async function resumeConfirmedOperation(options:Options,state:State):Promise<State> {
    const action=actions(state)[state.step];
    const view=await options.view(state.boardId,state.itemId),entry=view.operations.find(row=>row.id===action);
    if(entry?.state==='running'&&entry.runId===state.requests[action]?.operationId){
        const resumed=await options.journal.update<State>(key(state.boardId,state.itemId,state.scopeId),old=>({...old!,code:undefined}));
        await reportDelivery(options,resumed);return resumed;
    }
    if(entry?.enabled&&!entry.runId&&state.code&&await options.retryPrecondition?.(state.boardId,state.itemId,action,state.code)){
        const previous=state.requests[action];
        await options.journal.update('automatic-precondition-retry:'+previous.operationId,old=>old??previous);
        const request={...previous,operationId:state.id+'-'+action+'-'+sha256HexSync(view.revision).slice(0,12),expectedRevision:view.revision};
        return options.journal.update<State>(key(state.boardId,state.itemId,state.scopeId),old=>({...old!,code:undefined,requests:{...old!.requests,[action]:request}}));
    }
    if(entry?.state!=='skipped'&&(entry?.state!=='succeeded'||!entry.runId))return state;
    return options.journal.update<State>(key(state.boardId,state.itemId,state.scopeId),old=>({...old!,code:undefined,step:old!.step+1,resolvedBy:entry.runId}));
}
async function advance(options:Options,state:State,manualOrder?:string[]) {
    const storageKey=key(state.boardId,state.itemId,state.scopeId),action=actions(state)[state.step];if(!await admitted(options,state))return;
    const snapshot=await options.view(state.boardId,state.itemId);
    if(snapshot.halted){if(snapshot.halted.state==='cancelled'){const next=await options.journal.update<State>(storageKey,old=>({...old!,code:'OPERATION_CANCELLED'}));await releaseDeliveryTarget(options,next);await reportDelivery(options,next);}return;}
    if(snapshot.skippedActions?.includes(action)){
        const next=await options.journal.update<State>(storageKey,old=>({...old!,step:old!.step+1,code:undefined}));
        await reportDelivery(options,next);return;
    }
    if(action===options.policy.finalizeAction) {
        if(!await admitted(options,state)||!options.cleanup||!await options.cleanup(state.boardId,state.itemId,state.id))return;
        const done=await options.journal.update<State>(storageKey,old=>({...old!,code:undefined,cleanupPrecondition:undefined,step:actions(state).length}));await reportDelivery(options,done);return;
    }
    const view=snapshot;if(!options.active())return;
    const id=state.requests[action]?.operationId??state.id+'-'+action+(state.revisionEpoch?'-'+state.revisionEpoch:''),entry=view.operations.find(row=>row.id===action);
    if(entry?.state==='succeeded'&&(entry.runId||action===options.policy.handoffAction)){
        await options.journal.update<State>(storageKey,old=>({...old!,step:old!.step+1,...(entry.runId!==id?{resolvedBy:entry.runId}:{})}));return;
    }
    if(state.manualAfter&&(manualOrder??actions(state)).indexOf(action)>(manualOrder??actions(state)).indexOf(state.manualAfter)) {
        await releaseDeliveryTarget(options,state);
        if(state.reportedBoundary!==action){const waiting=await options.journal.update<State>(storageKey,old=>({...old!,reportedBoundary:action}));await reportDelivery(options,waiting);}
        return;
    }
    if(entry?.runId===id) {
        if(entry.state==='failed'||entry.state==='cancelled'||entry.state==='unknown')throw Object.assign(new Error('Automatic step failed'),{code:entry.code??(entry.state==='unknown'?'OPERATION_OUTCOME_UNKNOWN':'AUTOMATIC_STEP_FAILED')});
        return;
    }
    if(!entry?.enabled)return;
    if(entry.fields?.length)throw Object.assign(new Error('Conflict selection required'),{code:'OPERATION_SELECTION_REQUIRED'});
    const request=state.requests[action]??{operationId:id,itemId:state.itemId,scopeId:state.scopeId,action,expectedRevision:view.revision,selections:{}};
    state=await options.journal.update<State>(storageKey,old=>({...old!,requests:{...old!.requests,[action]:old!.requests[action]??request}}));
    if(await admitted(options,state))await options.run(state.boardId,state.requests[action]);
}
export async function automaticDeliveryStatus(journal:KanbanAutomationJournal,board:string,item:string,scopeId?:string,legacySteps:string[]=[]):Promise<NonNullable<KanbanItemOperations['automatic']>|undefined> {
    const state=await journal.get<State>(key(board,item,scopeId));
    if(!state)return;
    return deliveryStatus({...state,steps:state.steps??legacySteps});
}
/** Read existing finalization facts in one snapshot without advancing work. */
export async function automaticDeliveryStatuses(journal:KanbanAutomationJournal,targets:Array<{boardId:string;itemId:string}>,legacySteps:string[]=[]){
    const states=await journal.getMany<State>(targets.map(target=>key(target.boardId,target.itemId)));
    return states.map(state=>state?deliveryStatus({...state,steps:state.steps??legacySteps}):undefined);
}
