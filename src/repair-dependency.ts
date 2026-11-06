import type {KanbanActor,KanbanCommand} from './contracts';
import type {KanbanState} from './ports';
import {requireCoordinator} from './workflow-plans';
import {requireValue} from './rules';
import {validatePlan} from './planning';
import {dependencyRestartPreview} from './dependency-restart';
import type {RepairDependencyCommand} from './contracts/task-restart';
/** One transaction appends a repair and inserts its scheduling gate; terminal attempts stay immutable. */
export function insertRepairDependency(state:KanbanState,command:RepairDependencyCommand,actor:KanbanActor,now:number,apply:(command:KanbanCommand)=>void):void {
    requireCoordinator(state,actor);
    const item=state.board.items.find(row=>row.id===command.itemId);requireValue(item,'ITEM_NOT_FOUND');
    requireValue(item.revision===command.expectedItemRevision,'ITEM_REVISION_CONFLICT');
    requireValue(!item.restartPending&&!item.owner&&!item.transfer&&['backlog','open'].includes(item.status)&&item.control?.action!=='cancel','REPAIR_TARGET_UNAVAILABLE');
    const dispatches=Object.values(state.workflow?.dispatches??{}).filter(row=>row.itemId===item.id).sort((a,b)=>b.attempt-a.attempt);
    requireValue(dispatches[0]?.outcome==='failed'&&!dispatches.some(row=>['prepared','running','unknown','succeeded'].includes(row.outcome)),'REPAIR_REQUIRES_FAILED_EXECUTION');
    const affected=dependencyRestartPreview(state.board,item.id).affected;
    requireValue(affected.every(row=>row.id===item.id||['backlog','open'].includes(row.status)&&!state.board.items.find(other=>other.id===row.id)?.owner),'REPAIR_REQUIRES_DEPENDENCY_RESTART');
    const {plan}=command,repair=plan.items[0];
    requireValue(plan.mode==='append'&&plan.rootItemId===item.planning?.parentId&&!!plan.rootItemId&&plan.items.length===1,'REPAIR_GROUP_REQUIRED');
    requireValue(!state.board.items.some(row=>row.id===repair.id)&&!state.archiveIndex?.some(row=>row.id===repair.id),'ITEM_EXISTS');
    requireValue(!repair.dependsOn.includes(item.id),'DEPENDENCY_CYCLE');
    apply({type:'publish-plan',plan});
    const planning={...item.planning!,dependencies:[...item.planning?.dependencies??[],repair.id]};validatePlan(state,item,planning);
    item.repairPending={itemId:repair.id,previousDispatchId:dispatches[0].id};item.planning=planning;item.revision++;item.updatedAt=now;
}
