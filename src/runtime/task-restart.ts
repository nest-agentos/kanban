import type {KanbanClient,KanbanRestartPreview,KanbanRestartRequest,KanbanRestartResult} from '../contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import {dependencyRestartPreview} from '../dependency-restart';
import {journalCommand} from './journal-command';
import {requireValue} from '../rules';
import {sha256HexSync} from '../utils';
import {safeCode} from './diagnostics';
interface Intent {boardId:string;request:KanbanRestartRequest;digest:string;preview:KanbanRestartPreview;done?:boolean;code?:string}
interface Options {service:KanbanClient;journal:KanbanAutomationJournal;assertIdle?(board:string,ids:string[]):Promise<void>}
/** Drain receipts precede reset. Both phases survive host exit and response loss. */
export function createTaskRestart(options:Options) {
    let stopped=false;const pending=new Map<string,Promise<KanbanRestartResult>>();
    const serial=(key:string,work:()=>Promise<KanbanRestartResult>)=>{
        requireValue(!stopped,'SERVICE_STOPPING');const old=pending.get(key);if(old)return old;
        const next=work().finally(()=>pending.delete(key));pending.set(key,next);return next;
    };
    const restartTask=(boardId:string,request:KanbanRestartRequest)=>serial(request.operationId,async()=>{
        requireValue(request.confirmed===true&&/^[a-zA-Z0-9_-]{1,128}$/.test(request.operationId),'RESTART_CONFIRMATION_REQUIRED');
        const key='task-restart:'+request.operationId,digest=sha256HexSync(JSON.stringify([boardId,request]));
        let intent=await options.journal.get<Intent>(key);
        requireValue(!intent||intent.digest===digest,'IDEMPOTENCY_CONFLICT');
        if(!intent){const preview=dependencyRestartPreview(await options.service.read(boardId),request.itemId);requireValue(preview.version===request.version,'RESTART_PREVIEW_CHANGED');intent=await options.journal.update<Intent>(key,old=>{requireValue(!old||old.digest===digest,'IDEMPOTENCY_CONFLICT');return old??{boardId,request,digest,preview};});}
        return advance(options,intent,()=>!stopped);
    });
    return {previewTaskRestart:async(board:string,id:string)=>dependencyRestartPreview(await options.service.read(board),id),restartTask,
        scan:async()=>{for(const row of await options.journal.find<Intent>('task-restart:',value=>!value.done)){if(stopped)return;try{await serial(row.value.request.operationId,()=>advance(options,row.value,()=>!stopped));}catch(error){await reportFailure(options,row.value,error);}}},
        quiesce:async()=>{stopped=true;await Promise.allSettled([...pending.values()]);}};
}
async function advance(options:Options,intent:Intent,active:()=>boolean):Promise<KanbanRestartResult> {
    const {boardId,request,preview}=intent,affectedIds=preview.affected.map(row=>row.id);
    const result={operationId:request.operationId,itemId:request.itemId,affectedIds};if(intent.done)return {...result,state:'restarted'};
    requireValue(active(),'SERVICE_STOPPING');
    await journalCommand(options.journal,options.service,boardId,'restart.prepare:'+request.operationId,{type:'prepare-task-restart',itemId:request.itemId,restartId:request.operationId,version:request.version});
    const board=await options.service.read(boardId);requireValue(!board.deletedAt&&!board.lifecycle,'BOARD_STOPPING');
    if(affectedIds.some(id=>{const row=board.items.find(item=>item.id===id);return !row||!['completed','cancelled'].includes(row.status)||row.owner&&row.status!=='completed'||row.transfer;}))return {...result,state:'stopping',code:'RESTART_STOP_PENDING'};
    await options.assertIdle?.(boardId,affectedIds);requireValue(active(),'SERVICE_STOPPING');
    await journalCommand(options.journal,options.service,boardId,'restart.commit:'+request.operationId,{type:'commit-task-restart',itemId:request.itemId,restartId:request.operationId,affectedIds});
    await wakeRuns(options,boardId,request.operationId);
    await options.journal.update<Intent>('task-restart:'+request.operationId,old=>({...old!,done:true}));
    options.journal.diagnostic({operationId:request.operationId,boardId,stage:'task.restart.committed',result:'success',durationMs:0});
    return {...result,state:'restarted'};
}

async function wakeRuns(options:Options,boardId:string,epoch:string):Promise<void> {
    const board=await options.service.read(boardId),roots=new Set(board.items.filter(item=>item.executionEpoch===epoch).map(item=>item.id));
    type Run={boardId:string;rootItemId?:string;state:string;code?:string;updatedAt:number;archivedAt?:number};
    for(const row of await options.journal.find<Run[]>('record-runs:',rows=>rows.some(run=>run.boardId===boardId&&roots.has(run.rootItemId??'')&&run.archivedAt===undefined)))
        await options.journal.update<Run[]>(row.key,old=>(old??[]).map(run=>run.boardId===boardId&&roots.has(run.rootItemId??'')&&run.archivedAt===undefined?{...run,state:'running',code:undefined,updatedAt:Date.now()}:run));
}

async function reportFailure(options:Options,intent:Intent,error:unknown):Promise<void> {
    const code=safeCode(error,'RESTART_FAILED'),key='task-restart:'+intent.request.operationId;
    const old=await options.journal.get<Intent>(key);if(old?.code===code)return;
    await options.journal.update<Intent>(key,value=>({...value!,code}));
    options.journal.diagnostic({operationId:intent.request.operationId,boardId:intent.boardId,stage:'task.restart.recover',result:'failure',code,durationMs:0});
}
