import {DEFAULT_KANBAN_WORK_TYPES,type KanbanItem,type KanbanPrincipal} from './contracts';
import {kanbanTaskType} from './contracts/task-type';
import type {KanbanState,KanbanStore} from './ports';
import {allocateTaskId,numberEntities} from './numbering';
import {requireValue} from './rules';

interface Options {
    actor:KanbanPrincipal;
    ungrouped:{title:string;responsibility:string;acceptance:string};
    log(event:{operationId:string;stage:string;result:'success'|'failure';count?:number;code?:string;durationMs:number}):void;
}
/** Run explicitly during host initialization; ordinary reads never create or rewrite tasks. */
export async function migrateTaskHierarchy(store:KanbanStore,options:Options):Promise<void> {
    for(const id of await store.ids()) {
        const view=store.view?await store.view(id):undefined;
        if(view?.state.board.deletedAt!==undefined||view?.state.hierarchyVersion===1)continue;
        const started=Date.now(),operationId='migration:task-hierarchy:1:'+id;let count=0;
        try {
            await store.update(id,operationId,'kanban.task-hierarchy/1',state=>{
                requireValue(state,'BOARD_NOT_FOUND');if(state.hierarchyVersion===1)return state;
                count=normalize(state,options,Date.now());state.hierarchyVersion=1;
                if(count){state.board.revision++;state.events.push({sequence:++state.sequence,boardId:id,operationId,at:Date.now(),kind:'task.hierarchy.migrated',actor:options.actor,recipients:[],data:{}});}
                return state;
            });
            options.log({operationId,stage:'task.hierarchy.migrate',result:'success',count,durationMs:Date.now()-started});
        } catch(error) {
            options.log({operationId,stage:'task.hierarchy.migrate',result:'failure',code:typeof (error as {code?:string})?.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test((error as {code:string}).code)?(error as {code:string}).code:'TASK_HIERARCHY_MIGRATION_FAILED',durationMs:Date.now()-started});throw error;
        }
    }
}
function normalize(state:KanbanState,options:Options,now:number):number {
    numberEntities(state);const items=state.board.items.filter(item=>item.deletedAt===undefined),known=new Map(items.map(item=>[item.id,item]));
    const parents=new Set(items.flatMap(item=>item.planning?.parentId&&known.has(item.planning.parentId)?[item.planning.parentId]:[]));
    for(const item of items)if(kanbanTaskType(item)==='coordination')parents.add(item.id);
    const orphaned=items.filter(item=>!parents.has(item.id)&&!parents.has(item.planning?.parentId??''));let fallback:KanbanItem|undefined;
    if(orphaned.length){fallback=ungrouped(state,options,now);state.board.items.push(fallback);parents.add(fallback.id);}
    let changed=fallback?1:0;
    for(const item of items) {
        const type=parents.has(item.id)?'coordination':'execution',parentId=type==='coordination'?undefined:parents.has(item.planning?.parentId??'')?item.planning!.parentId:fallback!.id;
        const execution=type==='coordination'?'children':'direct';
        if(item.taskType===type&&item.planning?.parentId===parentId&&item.planning?.execution===execution)continue;
        item.taskType=type;item.planning={...(item.planning??{kind:state.board.defaultWorkType??'task',priority:2,dependencies:[],references:[]}),execution};
        if(type==='execution'&&!(state.board.workTypes??DEFAULT_KANBAN_WORK_TYPES).some(kind=>kind.id===item.planning!.kind&&kind.executable))item.planning.kind=(state.board.workTypes??DEFAULT_KANBAN_WORK_TYPES).find(kind=>kind.executable)?.id??item.planning.kind;
        if(parentId)item.planning.parentId=parentId;else delete item.planning.parentId;
        item.revision++;changed++;
    }
    return changed;
}
function ungrouped(state:KanbanState,options:Options,now:number):KanbanItem {
    return {id:allocateTaskId(state),...options.ungrouped,taskType:'coordination',status:'backlog',revision:1,createdAt:now,updatedAt:now,readyAt:now,workUnits:0,participants:[],
        origin:{kind:'direct',principal:options.actor},planning:{kind:state.board.workTypes?.find(type=>!type.executable)?.id??state.board.defaultWorkType??'task',execution:'children',priority:2,dependencies:[],references:[]}};
}
