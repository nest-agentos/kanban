import {isKanbanHumanChecklistTask,type KanbanActor,type KanbanCommand,type KanbanItem} from './contracts';
import {taskEditing} from './contracts/task-projection';
import {eligible,principal} from './identity';
import {catalog,terminal} from './planning';
import type {KanbanState} from './ports';
import {requireValue,text} from './rules';

export function settleManualTask(state:KanbanState,item:KanbanItem,command:Extract<KanbanCommand,{type:'settle-manual-task'}>,actor:KanbanActor,now:number):void {
    requireValue(isKanbanHumanChecklistTask(state.board,item),'HUMAN_CHECKLIST_REQUIRED');
    requireValue(principal(actor).kind==='human','FORBIDDEN');
    eligible(state.board,item,actor);
    requireValue(command.outcome==='completed'||command.outcome==='cancelled','INVALID_TASK_OUTCOME');
    requireValue(['backlog','open'].includes(item.status)&&!item.owner&&item.launch?.admittedAt===undefined&&!item.restartPending,'ITEM_NOT_PLANNABLE');
    requireValue(!taskEditing(item,now),'EDIT_LEASE_ACTIVE');
    requireValue(item.control?.action!=='cancel','TASK_CANCELLING');
    if(command.note!==undefined)text(command.note);
    const parent=state.board.items.find(row=>row.id===item.planning?.parentId);
    requireValue(parent&&!parent.deletedAt&&['backlog','open'].includes(parent.status)&&!parent.owner
        &&parent.planning?.execution==='children'&&parent.control?.action!=='cancel','PARENT_UNAVAILABLE');
    if(command.outcome==='completed'){
        requireValue(!item.blocked,'ITEM_BLOCKED');
        requireValue(item.planning!.dependencies.every(id=>catalog(state).some(row=>row.id===id&&row.status==='completed')),'DEPENDENCIES_UNFINISHED');
    }
    close(item,command.outcome,now);
    item.manualOutcome={...(command.note?{note:command.note}:{})};
    const children=catalog(state).filter(row=>row.planning.parentId===parent.id&&row.deletedAt===undefined);
    if(children.every(row=>terminal(row)&&isKanbanHumanChecklistTask(state.board,row))) {
        close(parent,children.every(row=>row.status==='completed')?'completed':'cancelled',now);
    }
}
function close(item:KanbanItem,outcome:'completed'|'cancelled',now:number):void {
    item.status=outcome;
    item.closedAt=item.updatedAt=now;
    item.revision++;
}
