import type {KanbanBoard,KanbanItem,KanbanService,KanbanTaskRecoveryRequest,KanbanTaskRecoveryResult} from '../contracts';
import {sha256HexSync} from '../utils';
import {requireValue} from '../rules';
import type {KanbanAutomationJournal} from './automation-journal';
import {safeCode} from './diagnostics';
export interface TaskResultRecovery {boardId:string;itemId:string;dispatchId:string;resultId:string;done?:boolean}
export interface TaskResultRecoveryPorts {
    journal:KanbanAutomationJournal;service:Pick<KanbanService,'read'|'workflow'>;active():boolean;
    authorized(board:KanbanBoard,item:KanbanItem):Promise<boolean>;
    inspect(board:string,item:string):Promise<{revision:string;canRetry:boolean}>;
    recover(board:string,request:KanbanTaskRecoveryRequest):Promise<KanbanTaskRecoveryResult>;
    log(event:{operationId:string;boardId:string;stage:string;result:'success'|'failure';code?:string;durationMs:number}):void;
}
const index='task-recovery-results',key=(dispatchId:string)=>'task-recovery-result:'+dispatchId;
export function registeredTaskResult(journal:KanbanAutomationJournal,dispatchId:string):Promise<TaskResultRecovery|undefined> {
    return journal.get<TaskResultRecovery>(key(dispatchId));
}
/** Candidate and pending index commit together; historical results never enter later scans. */
export async function registerTaskResultRecovery(journal:KanbanAutomationJournal,value:TaskResultRecovery):Promise<void> {
    let pending=false;const id=key(value.dispatchId);
    await journal.updateMany([{key:id,change:raw=>{
        const old=raw as TaskResultRecovery|undefined;
        requireValue(!old||old.boardId===value.boardId&&old.itemId===value.itemId&&old.resultId===value.resultId,'RESULT_RECOVERY_CONFLICT');
        pending=!old?.done;return old??value;
    }},{key:index,change:raw=>{const ids=(raw??[]) as string[];return pending&&!ids.includes(id)?[...ids,id]:ids;}}]);
}
export async function resumeTaskResultRecovery(ports:TaskResultRecoveryPorts):Promise<void> {
    const ids=await ports.journal.get<string[]>(index)??[],values=await ports.journal.getMany<TaskResultRecovery>(ids);
    for(let i=0;i<ids.length;i++){
        if(!ports.active())return;const value=values[i];if(!value||value.done)continue;
        const started=Date.now();try{await resume(ports,ids[i],value,started);}
        catch(error){ports.log({operationId:value.dispatchId,boardId:value.boardId,stage:'task.result.recovery',result:'failure',code:safeCode(error,'RESULT_RECOVERY_PENDING'),durationMs:Date.now()-started});}
    }
}
async function resume(ports:TaskResultRecoveryPorts,id:string,value:TaskResultRecovery,started:number):Promise<void> {
    const board=await ports.service.read(value.boardId),item=board.items.find(item=>item.id===value.itemId);
    if(!item||item.deletedAt||['review','completed','cancelled'].includes(item.status)||item.control?.action==='cancel'){await finish(ports.journal,id);return;}
    if(board.lifecycle||!board.automation?.enabled||board.executionControl?.paused||!['backlog','open'].includes(item.status))return;
    const workflow=await ports.service.workflow(board.id),latest=Object.values(workflow.dispatches).filter(dispatch=>dispatch.itemId===item.id).sort((a,b)=>b.attempt-a.attempt)[0];
    if(latest?.id!==value.dispatchId){await finish(ports.journal,id);return;}
    if(!['failed','cancelled','rejected'].includes(latest.outcome)||!await ports.authorized(board,item))return;
    const state=await ports.inspect(board.id,item.id);if(!state.canRetry)return;
    const operationId='completed-result-'+sha256HexSync(JSON.stringify([value.boardId,value.itemId,value.dispatchId,value.resultId])).slice(0,48);
    const result=await ports.recover(board.id,{operationId,itemId:item.id,expectedRevision:state.revision,action:'retry'});
    if(result.state==='accepted'){await finish(ports.journal,id);ports.log({operationId,boardId:board.id,stage:'task.result.recovery',result:'success',durationMs:Date.now()-started});}
}
async function finish(journal:KanbanAutomationJournal,id:string):Promise<void> {
    await journal.updateMany([{key:id,change:old=>({...old as TaskResultRecovery,done:true})},
        {key:index,change:old=>((old??[]) as string[]).filter(value=>value!==id)}]);
}
