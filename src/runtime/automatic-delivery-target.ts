import {deliveryKey,deliveryComplete,deliveryNeedsTarget} from './automatic-delivery-state';
import type {AutomaticDeliveryState} from './automatic-delivery-types';
import {reserveJournalResource,releaseJournalResource} from './resource-reservation';
import type {KanbanService} from '../contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import {jobKey,reviewKey} from './delivery-policy';
interface ReviewSettings {jobs:string[]}
interface ReviewJob {phase:string}
export interface DeliveryScope {scopeId?:string;id:string;boardId:string;itemId:string;target?:string}
interface Ports {service:KanbanService;journal:KanbanAutomationJournal;releasableTarget?(scope:DeliveryScope,state:AutomaticDeliveryState):Promise<boolean>}
const key=(target:string)=>'automatic-target:'+JSON.stringify(target);
/** Reserve a business target across asynchronous jobs, without holding a storage transaction open. */
export async function claimDeliveryTarget(ports:Ports,scope:DeliveryScope):Promise<boolean>{
    if(!scope.target)return true;
    let reclaimed:DeliveryScope|undefined;const started=Date.now();
    const claimed=await reserveJournalResource(ports.journal,key(scope.target),binding(scope),async owner=>{
        const ready=await releasable(ports,owner);if(ready)reclaimed=owner;return ready;},sameBinding);
    if(claimed&&reclaimed)ports.journal.diagnostic({operationId:scope.id,boardId:reclaimed.boardId,itemId:reclaimed.itemId,stage:'automatic.target.reclaimed',result:'success',durationMs:Date.now()-started});
    return claimed;
}
export async function releaseDeliveryTarget(ports:Ports,scope:DeliveryScope):Promise<void>{
    if(scope.target)await releaseJournalResource(ports.journal,key(scope.target),binding(scope),sameBinding);
}
const binding=({id,boardId,itemId,target,scopeId}:DeliveryScope):DeliveryScope=>({id,boardId,itemId,target,scopeId});
const sameBinding=(left:DeliveryScope,right:DeliveryScope)=>left.boardId===right.boardId&&left.itemId===right.itemId&&left.target===right.target&&left.scopeId===right.scopeId;
async function releasable(ports:Ports,scope:DeliveryScope):Promise<boolean> {
    const state=await ports.journal.get<AutomaticDeliveryState>(deliveryKey(scope.boardId,scope.itemId,scope.scopeId));
    if(deliveryComplete(state))return true;
    let stopped=false;
    try{const detail=await ports.service.item(scope.boardId,scope.itemId);stopped=!!detail.archive||detail.item.deletedAt!==undefined||detail.item.status==='cancelled';}
    catch(error){if(!['BOARD_NOT_FOUND','ITEM_NOT_FOUND'].includes((error as {code:string}).code))throw error;stopped=true;}
    const independent=state?.id===scope.id&&(!deliveryNeedsTarget(state)||await ports.releasableTarget?.(scope,state)===true);
    if(!stopped&&!independent)return false;
    const settings=await ports.journal.get<ReviewSettings>(reviewKey(scope.boardId,scope.itemId,scope.scopeId));
    const jobs=await ports.journal.getMany<ReviewJob>((settings?.jobs??[]).map(jobKey));
    return jobs.every(job=>job?.phase==='settled');
}
