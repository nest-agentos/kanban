import type {KanbanActor,KanbanTaskCommand} from './contracts';
import type {KanbanState} from './ports';
import {requireCoordinator} from './workflow-plans';
import {requireValue,identity} from './rules';
type Command=Extract<KanbanTaskCommand,{type:'waive-execution-checks'}>;
/** Waiving named checks never resolves an issue or manufactures execution success. */
export function waiveExecutionChecks(state:KanbanState,input:Command,actor:KanbanActor,now:number):void {
 requireCoordinator(state,actor);requireValue(actor.kind==='human','FORBIDDEN');
 const item=state.board.items.find(row=>row.id===input.itemId),dispatch=state.workflow?.dispatches[input.dispatchId];
 requireValue(item&&dispatch?.itemId===item.id,'EXECUTION_NOT_FOUND');
 const latest=Object.values(state.workflow!.dispatches).filter(row=>row.itemId===item.id).sort((a,b)=>b.attempt-a.attempt)[0];
 requireValue(latest?.id===dispatch.id&&dispatch.outcome==='running'&&item.owner?.token===dispatch.fence,'STALE_EXECUTION_RESULT');
 requireValue(!item.deletedAt&&item.status==='claimed'&&item.control?.action!=='cancel','TASK_CANCELLING');
 requireValue(item.revision===input.expectedItemRevision,'REVISION_CONFLICT');
 identity(input.waiver.id);const {checks,reason}=input.waiver;
 requireValue(typeof reason==='string'&&reason.trim().length>0&&reason.length<=2000,'INVALID_CHECK_WAIVER');
 requireValue(Array.isArray(checks)&&checks.length>0&&checks.length<=16&&new Set(checks).size===checks.length&&checks.every(row=>typeof row==='string'&&row.trim().length>0&&row.length<=1000),'INVALID_CHECK_WAIVER');
 requireValue((item.executionCheckWaivers?.length??0)<64&&!item.executionCheckWaivers?.some(row=>row.id===input.waiver.id),'WAIVER_ALREADY_EXISTS');
 item.executionCheckWaivers=[...item.executionCheckWaivers??[],{...structuredClone(input.waiver),dispatchId:dispatch.id,acceptance:item.acceptance,actor:{...actor},at:now}];
}
