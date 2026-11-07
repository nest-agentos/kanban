import type {KanbanActor} from './contracts';
import type {KanbanState} from './ports';
import {taskCleanupAllowed} from './contracts/task-cleanup';
import {requireValue} from './rules';
import {principal} from './identity';

function cleanupScope(state:KanbanState,ids:string[]):string[] {
    const selected=new Set(ids);
    requireValue(state.board.items.filter(item=>selected.has(item.id)).every(item=>!item.planning?.parentId||selected.has(item.planning.parentId)),'SUBTASK_CLEANUP_VIA_GROUP');
    for(let pass=0;pass<state.board.items.length;pass++){
        const added=state.board.items.filter(item=>!item.deletedAt&&item.planning?.parentId&&selected.has(item.planning.parentId)&&!selected.has(item.id));
        if(!added.length)break;for(const item of added)selected.add(item.id);
    }
    return [...selected];
}
/** Cleanup closes only proven stopped work and never cascades along dependency edges. */
export function prepareItemCleanup(state:KanbanState,ids:string[],actor:KanbanActor,now:number,deleting=false):string[] {
    const selected=cleanupScope(state,ids),items=state.board.items.filter(row=>selected.includes(row.id)).reverse();
    if(deleting)requireValue(!state.board.items.some(row=>!selected.includes(row.id)&&!row.deletedAt&&!['completed','cancelled'].includes(row.status)&&row.planning?.dependencies.some(id=>selected.includes(id))),'TASK_HAS_DEPENDENTS');
    for(const item of items){
        if(['completed','cancelled'].includes(item.status))continue;
        requireValue(principal(actor).kind==='human','FORBIDDEN');
        requireValue(taskCleanupAllowed(item,state.workflow,state.board.items.filter(row=>!selected.includes(row.id))),'TASK_CLEANUP_EXECUTION_UNSETTLED');
        item.status='cancelled';item.closedAt=now;item.closureReason='USER_CLEANUP';item.updatedAt=now;item.revision++;
        delete item.owner;delete item.transfer;delete item.blocked;
    }
    return selected;
}
