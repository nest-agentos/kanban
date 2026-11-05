import {SeqKanbanStore} from '../storage';
import {createKanbanActivityModule} from '../activity';
import {KanbanAutomationJournal} from './automation-journal';
import {KanbanWorkLog} from './work-log';
import {defaultReferences} from './ports';
import {createRecordExecution} from './record-execution';
import {createKanbanAutomation} from './automation';
import {createBoardDeletion,withBoardDeletion} from './board-deletion';
import {scanBoardStopWork} from './board-stop-work';
import {scanTaskControls} from './task-controls';
import {verifyRuntimeLifecycle,runtimeLifecycle} from './runtime-lifecycle';
import type {KanbanRuntimeOptions,KanbanRuntimeContext,KanbanRuntimeExtension} from './runtime-ports';
import type {KanbanActor} from '../contracts';

/** One entry point owns durable coordination; the host supplies I/O and authorization. */
export async function assembleKanbanRuntime(options:KanbanRuntimeOptions) {
    const directory=options.directory??'/kanban',fs=options.fs;
    const store=options.store??await SeqKanbanStore.open(fs,directory);
    const journal=options.journal instanceof KanbanAutomationJournal?options.journal:new KanbanAutomationJournal(fs,{directory:directory+'/runtime',diagnostic:options.log,...options.journal});
    const workLog=new KanbanWorkLog(fs,{directory:directory+'/runtime',diagnostic:options.log,...options.workLog});
    await journal.open();await workLog.open();
    let verifyDeletion:(id:string)=>Promise<void>=async()=>{};
    const createService=options.createService??createKanbanActivityModule;
    const serviceFor=(actor:KanbanActor)=>createService({...options,store,actor,
        referenceSystem:options.referenceSystem??defaultReferences.execution,
        verifyLifecycle:async(board,command)=>{await verifyRuntimeLifecycle(service,journal,board,command);await options.verifyLifecycle?.(board,command);},
        verifyDeletion:async board=>{await verifyDeletion(board.id);await options.verifyDeletion?.(board);},
        onCommitted:async(id,source,now)=>{await workLog.synchronize(id,source);await options.onCommitted?.(id,source,now);}});
    const service=serviceFor(options.actor),context:KanbanRuntimeContext={fs,store,journal,workLog,service,serviceFor};
    const extensions=options.extensions?.(context)??[];
    return assembleRuntime(options,context,extensions,verify=>{verifyDeletion=verify;});
}
function assembleRuntime(options:KanbanRuntimeOptions,context:KanbanRuntimeContext,extensions:KanbanRuntimeExtension[],setDeletion:(verify:(id:string)=>Promise<void>)=>void) {
    const {service,journal,workLog}=context,directory=options.directory??'/kanban';
    const capabilities:Partial<import('../contracts').KanbanClient>=Object.assign({},...extensions.map(extension=>extension.capabilities));
    const records=options.resources?createRecordExecution({service,journal,archiveSession:options.archiveSession,resources:options.resources,requiresItemResource:options.requiresItemResource,planningSession:capabilities.planningSession,log:options.log??(()=>{})}):undefined;
    const automation=options.automation?createKanbanAutomation({...options.automation,...context,
        directory:directory+'/automation',log:options.log??(()=>{})}):undefined;
    const client={...service,...capabilities,
        ...(records?{...records,recordExecutions:async(board:string,id:string)=>(await workLog.record(service,board,id)).kind==='decision'?records.recordExecutions(board,id):[]}:{}),
        ...(automation?{automationCatalog:automation.automationCatalog,analysisStatus:automation.analysisStatus}:{}),
        records:(board:string,query?:import('../contracts').KanbanRecordQuery)=>workLog.records(service,board,query),
        record:(board:string,id:string)=>workLog.record(service,board,id)};
    const deletion=createBoardDeletion({service:client,journal});setDeletion(deletion.assertSettled);
    const participants=[...extensions,...records?[records]:[],...automation?[automation]:[]];
    const lifecycle=runtimeLifecycle(service,journal,participants,async()=>{
        await scanBoardStopWork({service,journal,ports:options.control??{control:{control:async()=> 'unknown'}},fixes:capabilities.cancelFix?{cancelFix:capabilities.cancelFix}:undefined,records});
        if(!automation&&options.control)for(const board of await service.list())await scanTaskControls(options.control,journal,board,service);
    });
    return {...context,service:withBoardDeletion({...client,...lifecycle},deletion)};
}
