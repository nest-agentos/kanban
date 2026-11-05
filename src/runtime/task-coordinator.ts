import {projectKanbanTask,type KanbanBoard,type KanbanItem,type KanbanService} from '../contracts';
import {sha256HexSync} from '../utils';
import type {KanbanAutomationJournal} from './automation-journal';
import {coordinateOperation} from './operation-runner';
import type {KanbanOperationRecord,KanbanOperationPort} from './operation-contracts';
import {safeCode} from './diagnostics';
export interface CoordinationSnapshot {boardId:string;revision:number;parent:KanbanItem;children:Array<{id:string;number?:number;title:string;status:string;phase:string;reason?:string;revision:number;dependencies:string[]}>}
export interface CoordinationOperation extends KanbanOperationRecord {event:string;snapshot:CoordinationSnapshot;request:unknown}
interface State {fingerprint?:string;pending?:string;latest?:string;code?:string}
interface Options {service:KanbanService;journal:KanbanAutomationJournal;
    prepare(id:string,snapshot:CoordinationSnapshot):Promise<unknown>;
    port:KanbanOperationPort<CoordinationOperation>}
/** Deterministic state changes wake an idle coordinator; the model never polls or owns child execution. */
export function createTaskCoordinator(options:Options) {
    return async(board:KanbanBoard,active:()=>boolean)=>{
        if(!board.automation)return;
        const workflow=await options.service.workflow(board.id);
        for(const parent of board.items.filter(item=>item.planning?.execution==='children'&&item.planning.coordination&&!item.deletedAt&&item.status!=='cancelled')) {
            if(!active())return;
            if(parent.control?.action==='cancel')continue;
            const admission=board.automation.enabled&&!board.executionControl?.paused&&!board.lifecycle&&parent.control?.action!=='pause';
            const children=board.items.filter(item=>item.planning?.parentId===parent.id&&!item.deletedAt).map(item=>{
                const task=projectKanbanTask(item,workflow,Date.now(),board.items);
                return {id:item.id,number:item.number,title:item.title,status:item.status,phase:task.phase,reason:task.reason,revision:item.revision,dependencies:item.planning?.dependencies??[]};
            }).sort((a,b)=>a.id.localeCompare(b.id));
            const snapshot={boardId:board.id,revision:board.revision,parent,children};
            try{await advance(options,snapshot,active,admission);}catch(error){await reportFailure(options,snapshot,error);}
        }
    };
}
async function advance(options:Options,snapshot:CoordinationSnapshot,active:()=>boolean,admission:boolean) {
    const {journal}=options,key='coordination:'+JSON.stringify([snapshot.boardId,snapshot.parent.id]);
    let state=await journal.get<State>(key)??{};
    if(state.pending){
        const job=await journal.get<CoordinationOperation>(state.pending);
        if(job&&active()){
            const settled=await coordinateOperation({service:options.service,journal,key:state.pending,record:job,port:options.port});
            if(settled.phase!=='settled')return;
            state=await journal.update<State>(key,old=>({...old,fingerprint:job.event,pending:undefined,code:undefined}));
        }
    }
    if(!active()||!admission)return;
    const fingerprint=sha256HexSync(JSON.stringify(snapshot.children.map(child=>[child.id,child.phase,child.reason])));
    if(state.fingerprint===fingerprint)return;
    if(!state.fingerprint&&!snapshot.children.some(child=>['waiting-input','error','unknown','review','completed','cancelled'].includes(child.phase))){await journal.update<State>(key,old=>({...old,fingerprint}));return;}
    const id='coordinate-'+sha256HexSync(JSON.stringify([snapshot.boardId,snapshot.parent.id,fingerprint,state.fingerprint])).slice(0,48),jobKey='coordination-operation:'+id;
    const frozen=await journal.update<CoordinationSnapshot>('coordination-snapshot:'+id,old=>old??snapshot);
    const existing=await journal.get<CoordinationOperation>(jobKey);
    if(!active())return;
    const job=existing??await journal.update<CoordinationOperation>(jobKey,old=>old??{id,boardId:snapshot.boardId,itemId:snapshot.parent.id,action:'coordinate',fingerprint:id,
        event:fingerprint,snapshot:frozen,request:null,phase:'prepared',state:'running',createdAt:Date.now()});
    if(!job.request){const request=await options.prepare(id,frozen);if(!active())return;await journal.update<CoordinationOperation>(jobKey,old=>({...old!,request:old!.request??request}));}
    await journal.update<State>(key,old=>({...old,pending:jobKey,latest:jobKey,code:undefined}));
    if(active())await coordinateOperation({service:options.service,journal,key:jobKey,record:(await journal.get<CoordinationOperation>(jobKey))!,port:options.port});
}
async function reportFailure(options:Options,snapshot:CoordinationSnapshot,error:unknown) {
    const key='coordination:'+JSON.stringify([snapshot.boardId,snapshot.parent.id]),code=safeCode(error,'COORDINATION_FAILED');
    const old=await options.journal.get<State>(key);if(old?.code===code)return;
    await options.journal.update<State>(key,current=>({...current,code}));
    options.journal.diagnostic({operationId:snapshot.parent.id,boardId:snapshot.boardId,itemId:snapshot.parent.id,stage:'coordination.prepare',result:'failure',code,durationMs:0});
}

export async function currentCoordination(journal:KanbanAutomationJournal,boardId:string,itemId:string) {
    const state=await journal.get<State>('coordination:'+JSON.stringify([boardId,itemId]));
    return state?.latest?journal.get<CoordinationOperation>(state.latest):undefined;
}
