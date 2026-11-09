import type {KanbanCommand,KanbanWorkDefinition,KanbanEstimate,KanbanClient,KanbanItem} from '../contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import {journalCommand} from './journal-command';
import {randomUUID,sha256HexSync} from '../utils';
import {requireValue} from '../rules';
import {safeCode} from './diagnostics';
export interface CollaborationCommit {id:string;boardId:string;itemId:string;commandKey:string;command:KanbanCommand;children?:Array<KanbanWorkDefinition&{estimate?:KanbanEstimate}>;repairItemId?:string;repairAfterCommit?:boolean}
interface Intent {fingerprint:string;phase:'prepared'|'committed'|'delivered';input:CollaborationCommit}
/** Domain checkpoints and an immutable intent commit before effects; delivery is retriable by the same identity. */
export async function commitCollaboration(service:KanbanClient,journal:KanbanAutomationJournal,supplied:CollaborationCommit,deliver?:(operationId:string)=>Promise<void>):Promise<void>{
    const input=structuredClone(supplied);
    const started=Date.now(),key='collaboration-commit:'+input.id;let stage='prepare';
    try{
        const fingerprint=sha256HexSync(canonical(input)),changes=checkpoints(input);
        changes.push({key,change:old=>{const previous=old as Intent|undefined;requireValue(!previous||previous.fingerprint===fingerprint,'COLLABORATION_IDEMPOTENCY_CONFLICT');return previous??{fingerprint,phase:'prepared',input};}});
        const board=await service.read(input.boardId);
        changes.push({key:input.commandKey,change:old=>{
            const entry=old as {boardId?:string;request?:{command:KanbanCommand}}|undefined;
            requireValue(!entry||entry.request&&(!entry.boardId||entry.boardId===input.boardId)&&canonical(entry.request.command)===canonical(input.command),'COLLABORATION_IDEMPOTENCY_CONFLICT');
            return entry??{boardId:input.boardId,request:{operationId:randomUUID(),expectedRevision:board.revision,command:input.command}};
        }});
        await journal.updateMany(changes);
        let intent=(await journal.get<Intent>(key))!;
        if(intent.phase==='prepared'){
            stage='commit';await journalCommand(journal,service,input.boardId,input.commandKey,intent.input.command);
            intent=await journal.update<Intent>(key,old=>old?.phase==='prepared'?{...old,phase:'committed'}:old!);
        }
        if(deliver&&intent.phase!=='delivered'){
            stage='deliver';await deliver(input.id);await journal.update<Intent>(key,old=>({...old!,phase:'delivered'}));
        }
        report(journal,{operationId:input.id,boardId:input.boardId,itemId:input.itemId,stage:'collaboration.'+stage,result:'success',durationMs:Date.now()-started});
    }catch(error){report(journal,{operationId:input.id,boardId:input.boardId,itemId:input.itemId,stage:'collaboration.'+stage,result:'failure',code:safeCode(error,'COLLABORATION_COMMIT_FAILED'),durationMs:Date.now()-started});throw error;}
}
function checkpoints(input:CollaborationCommit):Array<{key:string;change(previous:unknown):unknown}>{
    const rows:Array<{key:string;change(previous:unknown):unknown}>=[];
    if(input.repairItemId)rows.push({key:'repair-resumption:'+input.id,change:old=>old??{fixId:input.id,boardId:input.boardId,itemId:input.repairItemId,done:false,...(input.repairAfterCommit?{commitId:input.id}:{})}});
    for(const child of input.children??[]){
        if(child.estimate)rows.push({key:'decomposition-estimate:'+JSON.stringify([input.boardId,child.id]),change:old=>old??child.estimate});
        rows.push({key:'decomposition-status:'+JSON.stringify([input.boardId,child.id]),change:old=>old??{itemId:child.id,state:'ready',dependencies:child.dependsOn}});
    }
    return rows;
}
export interface RepairResumption {commitId?:string;fixId:string;boardId:string;itemId:string;done:boolean}
/** Domain eligibility is shared; the host supplies current execution and version evidence. */
export async function resumeCollaborationRepairs(service:KanbanClient,journal:KanbanAutomationJournal,active:()=>boolean,resume:(boardId:string,item:KanbanItem,operationId:string)=>Promise<void>):Promise<void>{
    for(const {key,value}of await journal.find<RepairResumption>('repair-resumption:',row=>!row.done)){
        if(!active())return;
        const committed=value.commitId?await journal.get<Intent>('collaboration-commit:'+value.commitId):undefined;
        const accepted=value.commitId?committed?.phase==='committed'||committed?.phase==='delivered':(await journal.get<{accepted?:boolean}>('fix:'+value.fixId))?.accepted;
        if(!accepted)continue;
        const board=await service.read(value.boardId),item=board.items.find(row=>row.id===value.itemId);
        if(!item?.repairPending){await journal.update(key,()=>({...value,done:true}));continue;}
        if(!board.automation?.enabled||board.executionControl?.paused||board.executionControl?.mode==='manual'||board.lifecycle)continue;
        if(board.items.find(row=>row.id===item.repairPending!.itemId)?.status!=='completed')continue;
        if(!active())return;
        await resume(board.id,item,'repair-retry-'+sha256HexSync(JSON.stringify([board.id,item.id,item.repairPending])).slice(0,48));
    }
}

function canonical(value:unknown):string{return JSON.stringify(value,(_key,row)=>row&&typeof row==='object'&&!Array.isArray(row)?Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])):row);}
function report(journal:KanbanAutomationJournal,event:Parameters<KanbanAutomationJournal['diagnostic']>[0]):void{try{journal.diagnostic(event);}catch{/* Diagnostics cannot change a committed result. */}}
