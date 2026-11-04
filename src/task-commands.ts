import {boardAllowsStart} from './contracts/board-control';
import {sha256HexSync} from './utils';
import type {KanbanActor, KanbanCommand, KanbanItem, KanbanTaskCommand} from './contracts';
import type {KanbanState} from './ports';
import {principal, principalKey} from './identity';
import {identity, requireValue, text} from './rules';
import {taskDue, taskEditing, taskStartAt} from './contracts/task-projection';
import {validatePlan, catalog} from './planning';
import {attachReference} from './planning-commands';
import {requireCoordinator} from './workflow-plans';

const types = ['set-launch-mode', 'retry-analysis', 'begin-edit', 'end-edit', 'save-edit', 'request-run', 'admit-item', 'report-analysis', 'request-control', 'control-receipt', 'report-issue', 'resolve-issue'];
export function taskCommand(command: KanbanCommand): command is KanbanTaskCommand {return types.includes(command.type);}
export function assertDefinitionEditable(item: KanbanItem, now: number, editId?: string, actor?: KanbanActor): void {
    requireValue(['proposed', 'backlog', 'open'].includes(item.status) && !item.owner && item.launch?.admittedAt === undefined, 'TASK_DEFINITION_FROZEN');
    if (taskEditing(item, now)) requireValue(item.launch!.editing!.id === editId && !!actor && principalKey(item.launch!.editing!.principal) === principalKey(principal(actor)), 'EDIT_LEASE_ACTIVE');
}
export function applyTaskCommand(state: KanbanState, command: KanbanTaskCommand, actor: KanbanActor, now: number): void {
    const item = state.board.items.find(i => i.id === command.itemId); requireValue(item, 'ITEM_NOT_FOUND');
    item.launch ??= {startAt: taskStartAt(item)};
    if (['begin-edit', 'end-edit', 'save-edit'].includes(command.type)) edit(state, item, command, actor, now);
    else if(command.type==='retry-analysis') {
        identity(command.retryId);requireValue(['failed','clarification'].includes(item.analysis?.state??'')&&!item.owner,'ANALYSIS_NOT_RETRYABLE');
        item.launch.analysisEpoch=command.retryId;delete item.analysis;
    }
    else if (command.type === 'set-launch-mode') {assertDefinitionEditable(item, now); setMode(item, command.mode);}
    else if (command.type === 'request-run') {assertDefinitionEditable(item, now); item.launch.requestedAt ??= now;}
    else if (command.type === 'admit-item') {
        requireCoordinator(state, actor); assertDefinitionEditable(item, now);
        requireValue(boardAllowsStart(state.board, item), 'BOARD_EXECUTION_PAUSED');
        requireValue(command.trigger === 'manual' ? item.launch.requestedAt !== undefined : taskDue(item, now), 'START_NOT_DUE');
        requireValue(!item.blocked && item.control?.action !== 'pause', 'ITEM_BLOCKED');
        requireValue(item.planning?.dependencies.every(id => catalog(state).find(i => i.id === id)?.status === 'completed') ?? true, 'DEPENDENCIES_UNFINISHED');
        item.launch.admittedAt = now;
    } else if (command.type === 'report-analysis') {
        requireCoordinator(state, actor); identity(command.operationId); requireValue(command.status.itemId === item.id, 'ANALYSIS_SCOPE_MISMATCH');
        item.analysis = structuredClone(command.status);
    } else if (command.type === 'request-control') requestControl(state, item, command);
    else if (command.type === 'control-receipt') {
        requireCoordinator(state, actor); requireValue(item.control?.id === command.controlId, 'STALE_CONTROL_RECEIPT');
        requireValue(['accepted', 'paused', 'resumed', 'failed', 'unknown'].includes(command.state), 'INVALID_CONTROL_STATE');
        item.control!.state = command.state; item.control!.code = command.code;
    } else issues(state, item, command, actor);
    item.updatedAt = now; item.revision++;
}
function edit(state: KanbanState, item: KanbanItem, command: KanbanTaskCommand, actor: KanbanActor, now: number): void {
    if (command.type === 'begin-edit') {
        assertDefinitionEditable(item, now, command.editId, actor); identity(command.editId);
        requireValue(Number.isSafeInteger(command.leaseMs) && command.leaseMs >= 1000 && command.leaseMs <= 300000, 'INVALID_EDIT_LEASE');
        item.launch!.editing = {id: command.editId, principal: principal(actor), expiresAt: now + command.leaseMs}; return;
    }
    if (command.type !== 'save-edit' && command.type !== 'end-edit') return;
    assertDefinitionEditable(item, now, command.editId, actor);
    requireValue(taskEditing(item, now) && item.launch!.editing!.id === command.editId, 'EDIT_LEASE_EXPIRED');
    if (command.type === 'save-edit') {
        text(command.title); text(command.responsibility); text(command.acceptance); validatePlan(state, item, command.planning);
        if (command.launchMode !== undefined) setMode(item, command.launchMode);
        Object.assign(item, {title: command.title, responsibility: command.responsibility, acceptance: command.acceptance, planning: command.planning});
        if (command.externalRefs) {item.externalRefs = []; for (const ref of command.externalRefs) attachReference(item, ref);}
    }
    if(command.type==='save-edit')for(const plan of Object.values(state.workflow?.plans??{})) {
        const definition=plan.definitions[item.id];if(!definition)continue;
        requireValue(Object.values(definition.inputs??{}).every(binding=>item.planning?.dependencies.includes(binding.fromItemId)),'EXISTING_DEPENDENCY_REQUIRED');
        definition.digest=sha256HexSync(JSON.stringify([item.title,item.responsibility,item.acceptance,item.planning,item.externalRefs,definition.inputs,definition.outputs]));
    }
    delete item.launch!.editing;
}
function requestControl(state: KanbanState, item: KanbanItem, command: Extract<KanbanTaskCommand, {type: 'request-control'}>): void {
    requireValue(!['completed', 'cancelled', 'review'].includes(item.status), 'ITEM_COMPLETED'); identity(command.controlId);
    requireValue(['pause', 'resume'].includes(command.action), 'INVALID_CONTROL_ACTION');
    if (item.control?.id === command.controlId) {requireValue(item.control.action === command.action, 'IDEMPOTENCY_CONFLICT'); return;}
    requireValue(!item.control || !['requested', 'unknown'].includes(item.control.state), 'CONTROL_UNSETTLED');
    const dispatch = Object.values(state.workflow?.dispatches ?? {}).find(d => d.itemId === item.id && ['prepared', 'running', 'unknown'].includes(d.outcome));
    requireValue(dispatch || item.launch?.admittedAt === undefined, 'TASK_CONTROL_UNSUPPORTED');
    requireValue(command.action === 'pause' || item.control?.action === 'pause', 'TASK_NOT_PAUSED');
    item.control = {id: command.controlId, dispatchId: dispatch?.id, action: command.action, state: 'requested'};
}
function issues(state: KanbanState, item: KanbanItem, command: KanbanTaskCommand, actor: KanbanActor): void {
    requireCoordinator(state, actor);
    if (command.type === 'report-issue') {
        const issue = command.issue; identity(issue.id); identity(issue.attemptId);
        requireValue(!issue.resolvedBy && ['clarification', 'error'].includes(issue.type), 'INVALID_ISSUE');
        requireValue(state.workflow?.dispatches[issue.attemptId]?.itemId === item.id && item.owner?.token === state.workflow.dispatches[issue.attemptId].fence, 'STALE_EXECUTION_RESULT');
        item.issues ??= []; const old = item.issues.find(i => i.id === issue.id && i.attemptId === issue.attemptId);
        if (!old) {requireValue(item.issues.length < 200, 'ISSUE_LIMIT'); item.issues.push(structuredClone(issue));}
    } else if (command.type === 'resolve-issue') {
        const issue = item.issues?.find(i => i.id === command.issueId && i.attemptId === command.attemptId); requireValue(issue, 'ISSUE_NOT_FOUND');
        identity(command.resolvedBy); requireValue(!issue.resolvedBy || issue.resolvedBy === command.resolvedBy, 'ISSUE_ALREADY_RESOLVED'); issue.resolvedBy = command.resolvedBy;
    }
}

export function initializeTaskLaunch(state:KanbanState,item:KanbanItem):boolean {
    if(item.launch)return false;
    const first=Object.values(state.workflow?.dispatches??{}).filter(d=>d.itemId===item.id).sort((a,b)=>a.attempt-b.attempt)[0];
    const admittedAt=first?.preparedAt??item.owner?.claimedAt;
    item.launch={startAt:taskStartAt(item),...(admittedAt===undefined?{}:{admittedAt})};item.revision++;return true;
}

function setMode(item: KanbanItem, mode: 'automatic' | 'manual'): void {
    requireValue(['automatic', 'manual'].includes(mode), 'INVALID_LAUNCH_MODE');
    item.launch!.mode = mode; delete item.launch!.requestedAt;
}
