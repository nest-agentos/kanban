import type {KanbanActor, KanbanWorkflowCommand} from './contracts';
import type {KanbanState} from './ports';
import {requireValue} from './rules';
import {requireCoordinator} from './workflow-plans';
type Command = Extract<KanbanWorkflowCommand, {type:'waive-operations'}>;
/** Human waivers retain the original execution and never manufacture operation success. */
export function waiveOperations(state:KanbanState, command:Command, actor:KanbanActor, now:number):void {
    requireCoordinator(state,actor); requireValue(actor.kind==='human','OPERATION_COORDINATOR_REQUIRED');
    const dispatch=state.workflow!.dispatches[command.dispatchId],item=state.board.items.find(row=>row.id===command.itemId);
    requireValue(item&&dispatch?.itemId===item.id&&['succeeded','accepted'].includes(dispatch.outcome),'EXECUTION_NOT_SUCCEEDED');
    const latest=Object.values(state.workflow!.dispatches).filter(row=>row.itemId===item.id).sort((a,b)=>b.attempt-a.attempt)[0];
    requireValue(latest?.id===dispatch.id&&item.revision===command.expectedItemRevision,'OPERATION_STALE_REFRESH');
    requireValue(!item.deletedAt&&!item.control?.action?.includes('cancel')&&['review','completed'].includes(item.status),'TASK_CANCELLING');
    const waiver=command.waiver;validate(waiver);
    if(waiver.acceptanceWaived)requireValue(item.status==='review'&&dispatch.outcome==='succeeded','OPERATION_ACCEPTANCE_UNAVAILABLE');
    requireValue(!(item.operationWaivers??[]).some(row=>row.id===waiver.id)&&(item.operationWaivers?.length??0)<64,'OPERATION_HISTORY_LIMIT');
    item.revision++;item.updatedAt=now;
    item.operationWaivers=[...item.operationWaivers??[],{...waiver,dispatchId:dispatch.id,actor:{...actor},at:now}];
}
function validate(waiver:Command['waiver']):void {
    requireValue(waiver&&typeof waiver.id==='string'&&/^[\w-]{1,128}$/.test(waiver.id)&&typeof waiver.reason==='string'&&waiver.reason.trim().length>0&&waiver.reason.length<=2000,'OPERATION_SKIP_REASON_REQUIRED');
    requireValue(waiver.acceptanceWaived===undefined||typeof waiver.acceptanceWaived==='boolean','OPERATION_SKIP_INVALID');
    const rows=waiver.operations,graph=waiver.dependencies;
    requireValue(Array.isArray(rows)&&rows.length>0&&rows.length<=32&&graph&&typeof graph==='object'&&!Array.isArray(graph)&&Object.keys(graph).length<=32,'OPERATION_SKIP_INVALID');
    requireValue(rows.every(row=>row&&typeof row.id==='string'&&['direct','dependency'].includes(row.cause)&&(row.previousRunId===undefined||typeof row.previousRunId==='string'&&row.previousRunId.length<=128)),'OPERATION_SKIP_INVALID');
    requireValue(new Set(rows.map(row=>row.id)).size===rows.length&&rows.filter(row=>row.cause==='direct').length===1,'OPERATION_SKIP_INVALID');
    for(const [id,deps] of Object.entries(graph))requireValue(/^[a-z][a-z0-9-]{0,63}$/.test(id)&&Array.isArray(deps)&&deps.length<=32&&deps.every(dep=>Object.hasOwn(graph,dep)&&dep!==id),'OPERATION_SKIP_INVALID');
    validateGraph(graph);
    requireValue(typeof waiver.action==='string'&&Object.hasOwn(graph,waiver.action),'OPERATION_SKIP_INVALID');
    const affected=new Set([waiver.action]);let previous=0;
    while(previous!==affected.size){previous=affected.size;for(const [id,deps] of Object.entries(graph))if(deps.some(dep=>affected.has(dep)))affected.add(id);}
    requireValue(rows.length===affected.size&&rows.every(row=>affected.has(row.id)&&row.cause===(row.id===waiver.action?'direct':'dependency')&&typeof row.previousState==='string'&&row.previousState.length<=64),'OPERATION_SKIP_INVALID');
}

function validateGraph(graph:Record<string,string[]>):void {
    const remaining=new Set(Object.keys(graph));
    while(remaining.size){const ready=[...remaining].filter(id=>graph[id].every(dep=>!remaining.has(dep)));requireValue(ready.length>0,'OPERATION_SKIP_INVALID');for(const id of ready)remaining.delete(id);}
}
