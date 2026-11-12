import {safeCode} from './diagnostics';
import {sha256HexSync} from '../utils';
import type {KanbanItemOperationRequest} from '../contracts';
import type {KanbanBoard,KanbanItem} from '../contracts';
export interface OperationAuthorityContext {
 board:KanbanBoard;item:KanbanItem;
 deliveryPlan?:{steps:string[];ordering?:'configured';manualAfter?:string;acceptanceConfirmation?:string|null};
 jobs:Array<{id:string;action:string;phase:string;state:string;followUp?:{request?:KanbanItemOperationRequest}}>;
}
export interface OperationAuthorityPorts {
 confirmationActions:string[];acceptanceAction:string;canonicalSteps:string[];followUpActions:Record<string,string>;
 automatic?(board:KanbanBoard,item:KanbanItem):Promise<boolean>;
 scopes?:{describe(board:string,item:string):Promise<{owner?:{boardId:string;itemId:string}}|undefined>;handoff?(board:KanbanBoard,item:KanbanItem):Promise<{boardId:string;itemId:string}|undefined>};
 log(event:{operationId:string;stage:string;result:'success'|'failure';code?:string;durationMs:number}):void;
}

import {selectDeliverySteps} from './delivery-policy';
import {requireValue} from '../rules';

export type OperationOrigin='manual'|'automatic'|{followUp:string};

/** Authority checks retain the same operation identity and safe diagnostics for both entry points. */
export async function requireOperationAuthority(options:OperationAuthorityPorts,context:OperationAuthorityContext,request:KanbanItemOperationRequest,origin:OperationOrigin):Promise<void> {
    const started=Date.now();
    try{await admitOperation(options,context,request,origin);options.log({operationId:request.operationId,stage:'operation.authority',result:'success',durationMs:Date.now()-started});}
    catch(error){options.log({operationId:request.operationId,stage:'operation.authority',result:'failure',code:safeCode(error,'OPERATION_AUTHORITY_FAILED'),durationMs:Date.now()-started});throw error;}
}

/** Automatic authority comes from host policy, never from a client confirmation flag. */
async function admitOperation(options:OperationAuthorityPorts,context:OperationAuthorityContext,request:KanbanItemOperationRequest,origin:OperationOrigin):Promise<void> {
    const confirmation=options.confirmationActions.includes(request.action)||request.action===options.acceptanceAction&&context.deliveryPlan?.acceptanceConfirmation!==null;
    if(origin==='manual'){if(confirmation)requireValue(request.confirmed===true,'OPERATION_CONFIRMATION_REQUIRED');return;}
    const plan=context.deliveryPlan,steps=selectDeliverySteps(plan?.steps??options.canonicalSteps,options.canonicalSteps,plan?.ordering);
    requireValue(!plan?.manualAfter||steps.includes(request.action)&&steps.includes(plan.manualAfter)&&steps.indexOf(request.action)<=steps.indexOf(plan.manualAfter),'OPERATION_CONFIRMATION_REQUIRED');
    if(typeof origin==='object'){
        const build=context.jobs.find(job=>job.id===origin.followUp&&options.followUpActions[job.action]===request.action);
        requireValue(build?.phase==='settled'&&build.state==='succeeded'&&!!build.followUp?.request
            &&sha256HexSync(JSON.stringify(build.followUp.request))===sha256HexSync(JSON.stringify(request)),'OPERATION_CONFIRMATION_REQUIRED');
        return;
    }
    const route=await options.scopes?.describe(context.board.id,context.item.id);
    const owner=request.action===options.acceptanceAction&&route?.owner?await options.scopes?.handoff?.(context.board,context.item):undefined;
    const handoff=!!owner&&owner.boardId===route?.owner?.boardId&&owner.itemId===route.owner.itemId;
    requireValue(handoff||!!await options.automatic?.(context.board,context.item),'OPERATION_CONFIRMATION_REQUIRED');
}
