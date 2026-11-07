import type {IFileSystem} from '@nestos/vfs-core';
import {boardAllowsStart,executableWorkItem,type KanbanActor,type KanbanBoard,type KanbanItem,type KanbanService,type KanbanArtifactRef,type KanbanAutomationCatalog} from '../contracts';
import {taskDue} from '../contracts/task-projection';
import {createKanbanExecutionBridge,type KanbanExecutionPort,type KanbanExecutionBridgeOptions} from '../execution';
import type {KanbanAutomationJournal} from './automation-journal';
import type {KanbanWorkLog} from './work-log';
import type {KanbanRuntimeDiagnostic} from './ports';
import {completeCompositePlans} from './analysis-aggregation';
import {analysisStatus} from './analysis';
import {safeCode} from './diagnostics';
import {requireValue} from '../rules';
export interface KanbanExecutorContext {
    boardId:string;service:KanbanService;
    dependencies(item:KanbanItem):Promise<unknown>;
}
export interface KanbanAutomationOptions {
    fs:IFileSystem;directory:string;service:KanbanService;journal:KanbanAutomationJournal;workLog?:KanbanWorkLog;
    serviceFor(actor:KanbanActor):KanbanService;
    catalog():Promise<KanbanAutomationCatalog>;
    executor(context:KanbanExecutorContext):Promise<KanbanExecutionPort>;
    deliveryReady?(boardId:string,item:KanbanItem):Promise<boolean>;
    coordinate?(board:KanbanBoard,active:()=>boolean):Promise<void>;
    analyze?(board:KanbanBoard,item:KanbanItem,service:KanbanService,active:()=>boolean):Promise<void>;
    controls?(board:KanbanBoard,service:KanbanService):Promise<void>;
    drain?(board:KanbanBoard,service:KanbanService):Promise<void>;
    executionReference?:KanbanExecutionBridgeOptions['executionReference'];
    log(event:KanbanRuntimeDiagnostic & {result:'success'|'failure'}):void;
}
type Bridge=Awaited<ReturnType<typeof createKanbanExecutionBridge>>;
export function createKanbanAutomation(options:KanbanAutomationOptions) {
    let stopped=false,pending:Promise<void>|undefined;const bridges=new Map<string,Bridge>();
    const scan=()=>stopped?Promise.resolve():pending??=scanBoards(options,bridges,()=>!stopped).finally(()=>{pending=undefined;});
    return {scan,async quiesce(){
        stopped=true;await Promise.allSettled([...bridges.values()].map(bridge=>bridge.quiesce()));
        let timer:ReturnType<typeof setTimeout>|undefined;
        try{await Promise.race([pending?.catch(()=>{}),new Promise<void>(resolve=>{timer=setTimeout(resolve,5000);})]);}
        finally{if(timer)clearTimeout(timer);await options.journal.drain();}
    },automationCatalog:()=>{requireValue(!stopped,'SERVICE_STOPPING');return options.catalog();},
        analysisStatus:async(board:string,item:string)=>(await options.service.item(board,item)).item.analysis??analysisStatus(options.journal,board,item),
        verifyOutputs:(outputs:KanbanArtifactRef[])=>options.journal.verify(outputs)};
}
async function scanBoards(options:KanbanAutomationOptions,bridges:Map<string,Bridge>,active:()=>boolean):Promise<void> {
    const errors:unknown[]=[];
    for(const entry of await options.service.catalog()) {
        if(!active())return;
        const started=Date.now();
        try {
            const board=await options.service.read(entry.id);if(!active())return;
            if(!board.automation){await options.controls?.(board,options.service);continue;}
            const service=options.serviceFor(board.automation.coordinator);
            let bridge=bridges.get(board.id);if(!bridge){bridge=await createBridge(options,board.id);bridges.set(board.id,bridge);}
            if(!active()){await bridge.quiesce();return;}
            await options.controls?.(board,service);if(!active())return;await bridge.scan();if(!active())return;
            await options.drain?.(await service.read(board.id),service);
            await planNext(options,await service.read(board.id),active);
            if(active())await bridge.scan();
            if(active())await completeCompositePlans(options.service,options.journal,board.id,options.serviceFor,options.deliveryReady);
            if(active())await options.coordinate?.(await service.read(board.id),active);
            options.log({operationId:board.id,boardId:board.id,stage:'automation.scan',result:'success',durationMs:Date.now()-started});
        }catch(error){errors.push(error);options.log({operationId:entry.id,boardId:entry.id,stage:'automation.scan',result:'failure',code:safeCode(error,'AUTOMATION_SCAN_FAILED'),durationMs:Date.now()-started});}
    }
    if(errors.length)throw new AggregateError(errors,'KANBAN_AUTOMATION_FAILED');
}
async function planNext(options:KanbanAutomationOptions,board:KanbanBoard,active:()=>boolean):Promise<void> {
    if(!options.analyze)return;
    const workflow=await options.service.workflow(board.id),planned=new Set(Object.values(workflow.plans).flatMap(plan=>plan.itemIds));
    const candidates=board.items.filter(item=>!planned.has(item.id)&&['backlog','open'].includes(item.status)&&!item.owner&&!item.blocked
        &&boardAllowsStart(board,item)&&(item.analysis?.state!=='failed'||item.analysis.code==='IDEMPOTENCY_CONFLICT')&&(item.purpose==='planning'&&!!item.externalRefs?.length||executableWorkItem(board,item))
        &&(!item.control||item.control.action==='resume'&&item.control.state==='resumed')&&(item.launch?.admittedAt!==undefined||taskDue(item,Date.now())));
    for(const item of candidates) {
        if(!active())return;if(!await dependenciesComplete(options.service,board,item))continue;
        const service=options.serviceFor(board.automation!.coordinator);
        if(item.launch?.admittedAt===undefined){if(!await admit(options,board,item,service))return;board=await service.read(board.id);Object.assign(item,board.items.find(row=>row.id===item.id));}
        const started = Date.now();
        try{await options.analyze(board,item,service,active);}
        catch(error){
            const code=safeCode(error,'AUTOMATION_ANALYSIS_PREPARATION_FAILED');
            if(['REVISION_CONFLICT','IDEMPOTENCY_CONFLICT'].includes(code)){options.log({operationId:item.id,boardId:board.id,stage:'automation.analysis.sync',result:'failure',code,durationMs:0});continue;}
            const latest=await service.read(board.id);
            await service.execute(board.id,{operationId:'analysis-prepare-failed:'+item.id+':'+item.revision,expectedRevision:latest.revision,command:{type:'report-analysis',itemId:item.id,operationId:item.id,status:{itemId:item.id,state:'failed',code}}});
            options.log({operationId:item.id,boardId:board.id,stage:'automation.analysis.prepare',result:'failure',code,durationMs:Date.now()-started});
        }
        const status=await analysisStatus(options.journal,board.id,item.id);
        if(status&&['analyzing','unknown','ready'].includes(status.state))return;
    }
}
async function admit(_options:KanbanAutomationOptions,board:KanbanBoard,item:KanbanItem,service:KanbanService):Promise<boolean> {
    const latest=await service.read(board.id);
    try{await service.execute(board.id,{operationId:'admit:'+item.id+':'+item.revision,expectedRevision:latest.revision,command:{type:'admit-item',itemId:item.id,trigger:item.launch?.requestedAt!==undefined?'manual':'automatic'}});return true;}
    catch(error){if(['REVISION_CONFLICT','TASK_DEFINITION_FROZEN','EDIT_LEASE_ACTIVE'].includes(safeCode(error,'')))return false;throw error;}
}
async function createBridge(options:KanbanAutomationOptions,boardId:string):Promise<Bridge> {
    const board=await options.service.read(boardId),service=options.serviceFor(board.automation!.coordinator);
    const executor=await options.executor({boardId,service,dependencies:item=>dependencyResults(options,boardId,item)});
    return createKanbanExecutionBridge({fs:options.fs,directory:options.directory+'/'+encodeURIComponent(boardId),boardId,service,
        worker:async actor=>options.serviceFor(actor),executor,executionReference:options.executionReference,
        autoDispatch:async()=>(await options.service.read(boardId)).automation?.enabled===true,
        ready:options.deliveryReady?async item=>{for(const id of item.planning?.dependencies??[])if(!await options.deliveryReady!(boardId,(await service.item(boardId,id)).item))return false;return true;}:undefined,
        estimate:item=>estimateFor(options.journal,boardId,item),
        authorize:async stage=>{const latest=await options.service.read(boardId);if(stage!=='inspect'){requireValue(latest.automation?.enabled,'AUTOMATION_PAUSED');requireValue(!latest.executionControl?.paused,'BOARD_EXECUTION_PAUSED');}},
        log:event=>options.log({...event,boardId})});
}
async function estimateFor(journal: KanbanAutomationJournal, boardId: string, item: KanbanItem) {
    const decomposed=await journal.get<import('../contracts').KanbanEstimate>('decomposition-estimate:'+JSON.stringify([boardId,item.id]));
    if(decomposed)return decomposed;
    const key = await journal.get<string>('analysis-current:' + JSON.stringify([boardId, item.id]));
    return key ? (await journal.get<{result?: {estimate?: import('../contracts').KanbanEstimate}}>(key))?.result?.estimate : undefined;
}
export async function dependencyResults(options: KanbanAutomationOptions, boardId: string, item: KanbanItem): Promise<unknown> {
    const workflow = await options.service.workflow(boardId), results: Array<{itemId: string; outputs: Array<{reference: KanbanArtifactRef; value: unknown}>}> = [];
    for (const itemId of item.planning?.dependencies ?? []) {
        const dispatch = Object.values(workflow.dispatches).filter(dispatch => dispatch.itemId === itemId).sort((a,b)=>b.attempt-a.attempt)[0];
        requireValue(!dispatch||dispatch.outcome==='accepted','DEPENDENCY_OUTPUT_INVALID');
        const outputs: Array<{reference: KanbanArtifactRef; value: unknown}> = [];
        for (const output of dispatch?.outputs ?? []) {
            requireValue(await options.journal.verify(dispatch?.outputs ?? [], dispatch?.id), 'DEPENDENCY_OUTPUT_INVALID');
            outputs.push({reference: output, value: JSON.parse((await options.journal.get<string>('artifact:' + output.sha256))!)});
        }
        results.push({itemId, outputs});
    }
    requireValue(new TextEncoder().encode(JSON.stringify(results)).byteLength <= 128 * 1024, 'DEPENDENCY_CONTEXT_TOO_LARGE');
    return results;
}

async function dependenciesComplete(service:KanbanService,board:KanbanBoard,item:KanbanItem):Promise<boolean> {
    for(const id of item.planning?.dependencies??[]) {
        const dependency=board.items.find(i=>i.id===id)??(await service.item(board.id,id)).item;
        if(dependency.status!=='completed')return false;
    }
    return true;
}
