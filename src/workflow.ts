import {boardAllowsStart} from './contracts/board-control';
import {taskDue, taskEditing, taskStartAt} from './contracts/task-projection';
import type {KanbanActor, KanbanCommand, KanbanWorkflowCommand, KanbanDispatch, KanbanArtifactRef} from './contracts';
import {sameAutomationBinding, executableWorkItem} from './contracts';
import type {KanbanState} from './ports';
import {identity, requireValue} from './rules';
import {principal} from './identity';
import {publishPlan, requireCoordinator, type ApplyWorkCommand} from './workflow-plans';
import {catalog} from './planning';
import {executionObservationChanged} from './execution-observation';
import {continueExecution} from './workflow-continuation';
export function isWorkflowCommand(command: KanbanCommand): command is KanbanWorkflowCommand {
    return ['publish-plan','prepare-dispatch','continue-execution','observe-execution','accept-execution'].includes(command.type);
}
/** Plan definitions and live admissions cannot be bypassed by ordinary board commands. */
export function protectWorkflowItem(state: KanbanState, command: KanbanCommand): void {
    if (command.type === 'configure-automation' && Object.values(state.workflow?.dispatches ?? {}).some(dispatch =>
        ['prepared', 'running', 'unknown', 'succeeded'].includes(dispatch.outcome))) {
        requireValue(sameAutomationBinding(state.board.automation, command.settings), 'PLAN_EXECUTION_UNSETTLED');
    }
    if (!('itemId' in command) || !command.itemId || !state.workflow) return;
    const plan=Object.values(state.workflow.plans).find(plan=>plan.itemIds.includes(command.itemId!));
    if (!plan) return;
    requireValue(!['edit-item','plan-item','review-amendment'].includes(command.type),'PLAN_ITEM_CHANGED_REQUIRES_NEW_ID');
    if (plan.sealed) requireValue(!['claim','submit','review','close-plan'].includes(command.type),'WORKFLOW_COMMAND_REQUIRED');
    const live=Object.values(state.workflow.dispatches).some(dispatch=>dispatch.itemId===command.itemId&&['prepared','running','unknown','succeeded'].includes(dispatch.outcome));
    if (live) requireValue(!['request-transfer','accept-transfer','release-item','cancel-item'].includes(command.type),'EXECUTION_UNSETTLED');
}
export function applyWorkflow(state: KanbanState, command: KanbanWorkflowCommand, actor: KanbanActor, now: number, apply: ApplyWorkCommand): boolean {
    state.workflow ??= {plans:{},dispatches:{},ready:[],completedPlans:[]};
    let changed = true;
    if (command.type === 'publish-plan') publishPlan(state,command.plan,actor,apply);
    else if (command.type === 'prepare-dispatch') prepare(state,command,actor,now,apply);
    else if (command.type === 'continue-execution') {requireValue(!state.board.executionControl?.paused, 'BOARD_EXECUTION_PAUSED'); continueExecution(state, command, actor, now, apply);}
    else if (command.type === 'observe-execution') changed = observe(state,command,actor,now);
    else accept(state,command,actor,apply);
    refreshReady(state);
    return changed;
}
function prepare(state: KanbanState, command: Extract<KanbanWorkflowCommand,{type:'prepare-dispatch'}>, actor: KanbanActor, now: number, apply: ApplyWorkCommand): void {
    identity(command.dispatchId); const workflow=state.workflow!;
    requireValue(!workflow.dispatches[command.dispatchId], 'DISPATCH_EXISTS'); refreshReady(state);
    requireValue(workflow.ready.includes(command.itemId), 'WORK_NOT_READY');
    const plan=Object.values(workflow.plans).find(plan=>plan.itemIds.includes(command.itemId))!;
    requireValue(!Object.values(workflow.dispatches).some(dispatch=>dispatch.itemId===command.itemId&&['prepared','running','unknown','succeeded'].includes(dispatch.outcome)), 'EXECUTION_UNSETTLED');
    const item=state.board.items.find(item=>item.id===command.itemId)!;
    if (item.status==='backlog') apply({type:'set-stage',itemId:item.id,stage:'open'});
    requireValue(!taskEditing(item, now), 'EDIT_LEASE_ACTIVE');
    requireValue(!state.board.executionControl?.paused, 'BOARD_EXECUTION_PAUSED');
    if (command.trigger === 'automatic') requireValue(boardAllowsStart(state.board, item) && taskDue(item, now), 'START_NOT_DUE');
    item.launch ??= {startAt: taskStartAt(item)}; item.launch.admittedAt ??= now;
    apply({type:'claim',itemId:item.id,estimate:command.estimate});
    const inputs: Record<string,KanbanArtifactRef>={};
    for(const [name,binding] of Object.entries(plan.definitions[item.id].inputs ?? {})) {
        const producer=Object.values(workflow.dispatches).reverse().find(dispatch=>dispatch.itemId===binding.fromItemId&&dispatch.outcome==='accepted');
        const output=producer?.outputs?.find(output=>output.name===binding.output);requireValue(output,'DEPENDENCY_OUTPUT_MISSING');inputs[name]=structuredClone(output);
    }
    const attempt=Math.max(0,...Object.values(workflow.dispatches).filter(dispatch=>dispatch.itemId===item.id).map(dispatch=>dispatch.attempt))+1;
    workflow.dispatches[command.dispatchId]={id:command.dispatchId,itemId:item.id,itemRevision:item.revision,planId:plan.id,planRevision:plan.revision,principal:principal(actor),definitionDigest:plan.definitions[item.id].digest,attempt,fence:item.owner!.token,preparedAt:now,outcome:'prepared',inputs};
}
function observe(state: KanbanState, command: Extract<KanbanWorkflowCommand,{type:'observe-execution'}>, actor: KanbanActor, now: number): boolean {
    requireCoordinator(state,actor); const dispatch=activeDispatch(state,command.dispatchId);
    requireValue(command.fence===dispatch.fence && ['prepared','running','unknown'].includes(dispatch.outcome),'STALE_EXECUTION_RESULT');
    requireValue(['running','unknown','succeeded','failed','cancelled'].includes(command.outcome),'INVALID_EXECUTION_OUTCOME');
    if(command.code!==undefined) requireValue(/^[A-Z][A-Z0-9_]{0,79}$/.test(command.code),'INVALID_ERROR_CODE');
    const item=state.board.items.find(item=>item.id===dispatch.itemId)!;
    if (command.executionSessionId) {identity(command.executionSessionId); requireValue(!dispatch.executionSessionId || dispatch.executionSessionId === command.executionSessionId, 'EXECUTION_SESSION_LOCKED'); dispatch.executionSessionId = command.executionSessionId;}
    if(command.controlCapabilities) {
        requireValue(['boundary','none'].includes(command.controlCapabilities.pause)&&typeof command.controlCapabilities.resume==='boolean','INVALID_CONTROL_CAPABILITIES');
        dispatch.controlCapabilities=structuredClone(command.controlCapabilities);
    }
    const outputs=command.outputs ?? [];validateOutputs(outputs);
    if (['running', 'unknown'].includes(command.outcome)) item.owner!.leaseUntil = Math.max(item.owner!.leaseUntil, now + state.board.policy.leaseMs);
    if (!executionObservationChanged(dispatch, command)) return false;
    if(command.outcome==='succeeded') {
        const required=state.workflow!.plans[dispatch.planId].definitions[item.id].outputs;
        requireValue(required.every(name=>outputs.some(output=>output.name===name)),'REQUIRED_OUTPUT_MISSING');
        item.status=state.board.policy.review==='assignee'?'completed':'review';if(item.status==='completed') item.closedAt=now;item.resultRef=`kanban:dispatch:${dispatch.id}`;dispatch.outputs=structuredClone(outputs);
    } else if(command.outcome==='failed'||command.outcome==='cancelled') {
        item.status='backlog';item.blocked={reason:command.code ?? 'EXECUTION_FAILED',at:now};delete item.owner;
    }
    dispatch.outcome=command.outcome==='succeeded'&&state.board.policy.review==='assignee'?'accepted':command.outcome;dispatch.code=command.code;item.updatedAt=now;item.revision++;dispatch.itemRevision=item.revision;
    return true;
}
function accept(state: KanbanState, command: Extract<KanbanWorkflowCommand,{type:'accept-execution'}>, actor: KanbanActor, apply: ApplyWorkCommand): void {
    requireCoordinator(state,actor);const dispatch=activeDispatch(state,command.dispatchId);
    requireValue(dispatch.outcome==='succeeded','EXECUTION_NOT_SUCCEEDED');
    apply({type:'review',itemId:dispatch.itemId,accept:command.accept},actor);
    dispatch.outcome=command.accept?'accepted':'rejected';
    if(!command.accept) {const item=state.board.items.find(item=>item.id===dispatch.itemId)!;item.status='backlog';item.blocked={reason:'EXECUTION_REJECTED',at:item.updatedAt};}
}
function activeDispatch(state: KanbanState, id: string): KanbanDispatch {
    const dispatch=state.workflow!.dispatches[id];requireValue(dispatch,'DISPATCH_NOT_FOUND');
    const item=state.board.items.find(item=>item.id===dispatch.itemId), plan=state.workflow!.plans[dispatch.planId];
    requireValue(plan?.revision===dispatch.planRevision&&item?.owner?.token===dispatch.fence&&plan.definitions[dispatch.itemId]?.digest===dispatch.definitionDigest,'STALE_EXECUTION_RESULT');return dispatch;
}
export function validateOutputs(outputs: KanbanArtifactRef[]): void {
    requireValue(Array.isArray(outputs)&&outputs.length<=100&&outputs.every(output=>output&&typeof output==='object'&&typeof output.name==='string')&&new Set(outputs.map(output=>output.name)).size===outputs.length,'INVALID_OUTPUTS');
    for(const output of outputs) requireValue(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(output.name)&&typeof output.ref==='string'&&output.ref.length>0&&output.ref.length<=2048
        &&/^[a-f0-9]{64}$/.test(output.sha256)&&Number.isSafeInteger(output.bytes)&&output.bytes>=0,'INVALID_OUTPUT_REFERENCE');
}
export function refreshReady(state: KanbanState): void {
    if(!state.workflow) return; const all=catalog(state), included=new Set(Object.values(state.workflow.plans).filter(plan=>plan.sealed).flatMap(plan=>plan.itemIds));
    state.workflow.completedPlans=Object.values(state.workflow.plans).filter(plan=>plan.sealed&&plan.itemIds.every(id=>all.find(item=>item.id===id)?.status==='completed')).map(plan=>plan.id);
    state.workflow.ready=state.board.items.filter(item=>included.has(item.id)&&executableWorkItem(state.board,item)&&['backlog','open'].includes(item.status)&&!item.owner&&!item.blocked&&item.control?.action!=='pause'
        &&(item.planning?.dependencies ?? []).every(id=>all.find(other=>other.id===id)?.status==='completed')).map(item=>item.id);
}
