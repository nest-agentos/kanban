import type {KanbanAutomationJournal} from './automation-journal';
import {requireValue} from '../rules';
interface Owner {id:string}
/** Evidence comes from the host; ownership changes only through the journal transaction. */
export async function reserveJournalResource<T extends Owner>(journal:KanbanAutomationJournal,key:string,scope:T,releasable:(owner:T)=>Promise<boolean>,same:(left:T,right:T)=>boolean):Promise<boolean>{
    const desired=structuredClone(scope),owner=await journal.update<T|null>(key,old=>old??desired);
    if(owner!.id===desired.id){requireValue(same(owner!,desired),'RESOURCE_RESERVATION_ID_CONFLICT');return true;}
    if(!await releasable(owner!))return false;
    const claimed=await journal.update<T|null>(key,old=>!old||old.id===owner!.id&&same(old,owner!)?desired:old);
    if(claimed?.id!==desired.id)return false;
    requireValue(same(claimed,desired),'RESOURCE_RESERVATION_ID_CONFLICT');return true;
}
export async function releaseJournalResource<T extends Owner>(journal:KanbanAutomationJournal,key:string,scope:T,same:(left:T,right:T)=>boolean):Promise<void>{
    await journal.update<T|null>(key,old=>{
        if(old?.id!==scope.id)return old??null;
        requireValue(same(old,scope),'RESOURCE_RESERVATION_ID_CONFLICT');return null;
    });
}
