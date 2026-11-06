import type {KanbanActor, KanbanWorkflowCommand} from './contracts';
import type {KanbanState} from './ports';
import {identity, requireValue} from './rules';
import {requireCoordinator, type ApplyWorkCommand} from './workflow-plans';

/** A new fenced attempt preserves terminal history and explicitly names its predecessor. */
export function continueExecution(state: KanbanState, command: Extract<KanbanWorkflowCommand, {type: 'continue-execution'}>,
    actor: KanbanActor, now: number, apply: ApplyWorkCommand): void {
    requireCoordinator(state, actor); identity(command.dispatchId);
    requireValue(!state.board.executionControl?.paused,'BOARD_EXECUTION_PAUSED');
    const workflow = state.workflow!, previous = workflow.dispatches[command.previousDispatchId];
    requireValue(previous && ['failed', 'cancelled', 'rejected'].includes(previous.outcome), 'EXECUTION_NOT_CONTINUABLE');
    requireValue(!workflow.dispatches[command.dispatchId], 'DISPATCH_EXISTS');
    const item = state.board.items.find(item => item.id === previous.itemId), plan = workflow.plans[previous.planId];
    requireValue(item && !item.restartPending && item.executionEpoch===previous.executionEpoch && ['backlog', 'open'].includes(item.status) && !item.owner, 'ITEM_NOT_CONTINUABLE');
    const attempts = Object.values(workflow.dispatches).filter(row => row.itemId === item.id);
    requireValue(attempts.every(row => row.attempt <= previous.attempt), 'STALE_CONTINUATION');
    requireValue(!attempts.some(row => ['prepared', 'running', 'unknown', 'succeeded'].includes(row.outcome)), 'EXECUTION_UNSETTLED');
    requireValue(plan && plan.definitions[item.id]?.digest === previous.definitionDigest, 'PLAN_CHANGED');
    requireValue(command.instruction === undefined || typeof command.instruction === 'string' && command.instruction.trim().length > 0
        && command.instruction.length <= 8000, 'INVALID_CONTINUATION_INSTRUCTION');
    requireValue(!item.blocked || item.blocked.reason === (previous.outcome === 'rejected' ? 'EXECUTION_REJECTED' : previous.code ?? 'EXECUTION_FAILED'), 'ITEM_BLOCKED');
    requireValue((item.planning?.dependencies??[]).every(id=>state.board.items.find(row=>row.id===id)?.status==='completed'||state.archiveIndex?.some(row=>row.id===id&&row.status==='completed')),'DEPENDENCIES_UNFINISHED');
    delete item.repairPending;
    delete item.blocked;
    if (item.status === 'backlog') apply({type: 'set-stage', itemId: item.id, stage: 'open'});
    apply({type: 'claim', itemId: item.id, estimate: item.estimate}, previous.principal);
    workflow.dispatches[command.dispatchId] = {executionEpoch:item.executionEpoch,id: command.dispatchId, itemId: item.id, itemRevision: item.revision,
        planId: previous.planId, planRevision: plan.revision, principal: previous.principal,
        definitionDigest: previous.definitionDigest, attempt: previous.attempt + 1, fence: item.owner!.token,
        preparedAt: now, outcome: 'prepared', inputs: structuredClone(previous.inputs),
        continuation: {previousDispatchId: previous.id, ...(command.instruction ? {instruction: command.instruction} : {})}};
}
