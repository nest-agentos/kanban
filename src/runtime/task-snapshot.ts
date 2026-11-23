import {kanbanTaskType,kanbanChildWorkType,projectKanbanTask,type KanbanClient,type KanbanTaskSnapshot,type KanbanTaskSnapshotOptions,type KanbanTaskRead} from '../contracts';
import type {KanbanRuntimeOptions} from './runtime-ports';
import {randomUUID} from '../utils';
import {requireValue} from '../rules';
import {safeCode} from './diagnostics';

export async function taskSnapshot(service:KanbanClient,boardId:string,itemId:string,log?:KanbanRuntimeOptions['log'],request?:KanbanTaskSnapshotOptions):Promise<KanbanTaskSnapshot> {
    const operationId=randomUUID(),started=Date.now();
    const report=(stage:string,result:'success'|'failure',since:number,code?:string)=>
        log?.({operationId,boardId,stage,result,code,durationMs:Date.now()-since});
    const read=async<T>(stage:string,operation:(()=>Promise<T>)|undefined):Promise<KanbanTaskRead<T>|undefined>=>{
        if(!operation)return;
        const since=Date.now();
        try{return {value:await operation()};}
        catch(error){const code=safeCode(error,'TASK_SNAPSHOT_READ_FAILED');report('task.snapshot.'+stage,'failure',since,code);return {code};}
    };
    try {
        requireValue(request===undefined||!!request&&typeof request==='object'&&!Array.isArray(request)&&Object.keys(request).every(key=>key==='includeSidebar')
            &&(request.includeSidebar===undefined||typeof request.includeSidebar==='boolean'),'INVALID_TASK_SNAPSHOT');
        const sidebarIncluded=request?.includeSidebar!==false;
        const [detail,boards,actor]=await Promise.all([service.item(boardId,itemId),sidebarIncluded?service.catalog():service.catalog(boardId),service.currentPrincipal()]);
        const board=boards.find(row=>row.id===boardId);
        requireValue(board,'BOARD_NOT_FOUND');
        const sections=await taskSections(service,board,detail,read);
        report('task.snapshot','success',started);
        return {boards,sidebarIncluded,actor,detail,...sections};
    }catch(error){report('task.snapshot','failure',started,safeCode(error,'TASK_SNAPSHOT_READ_FAILED'));throw error;}
}

async function taskSections(service:KanbanClient,board:KanbanTaskSnapshot['boards'][number],detail:KanbanTaskSnapshot['detail'],
    read:<T>(stage:string,operation:(()=>Promise<T>)|undefined)=>Promise<KanbanTaskRead<T>|undefined>) {
    const {item,archive}=detail,{id:boardId}=board,{id:itemId}=item,coordination=kanbanTaskType(item)==='coordination';
    const group=item.planning?.execution==='children';
    const query={parentId:itemId,view:'all' as const,limit:50};
    const phase=(detail.task??projectKanbanTask(item)).phase;
    const [resources,operations,planning,execution,recovery,children,workResources,successors]=await Promise.all([
        read('resources',service.recordResources&&(()=>service.recordResources!())),
        read('operations',service.itemOperations&&(()=>service.itemOperations!(boardId,itemId))),
        read('planning',coordination&&service.planningSession?()=>service.planningSession!(boardId,itemId):undefined),
        read('execution',!coordination&&service.executionSession?()=>service.executionSession!(boardId,itemId):undefined),
        read('recovery',!coordination&&!archive&&item.deletedAt===undefined&&['error','unknown'].includes(phase)&&service.taskRecovery?()=>service.taskRecovery!(boardId,itemId):undefined),
        read('children',kanbanChildWorkType(board,item)?()=>service.queryActivity?.(boardId,query)??service.query(boardId,query):undefined),
        read('resources.associations',group&&service.workResources?()=>service.workResources!(boardId,itemId,{inspect:false}):undefined),
        read('successors',item.status==='cancelled'?()=>service.query(boardId,{view:'all',restartedFrom:itemId,limit:50}):undefined),
    ]);
    return {resources,operations,planning,execution,recovery,children,workResources,successors};
}
