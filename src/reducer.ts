import {restartItemInput} from './task-restart';
import {stopBoard, protectStoppedBoard} from './board-stop';
import {setBoardControl} from './board-control';
import {taskCommand, applyTaskCommand, assertDefinitionEditable, initializeTaskLaunch} from './task-commands';
import {TASK_START_DELAY_MS} from './contracts/task-projection';
import {applyDiscovery} from './scan-commit';
import {configureAutomation} from './automation';
import {applyWorkflow, isWorkflowCommand, refreshReady, protectWorkflowItem} from './workflow';
import {allocateTaskId,numberEntities} from './numbering';
import {isRecordCommand, applyRecord} from './project-records';
import {reviewAmendment} from './amendments';
import {principal} from './identity';
import type { KanbanActor, KanbanBoard, KanbanCommand, KanbanEvent, KanbanItem } from './contracts';
import type { KanbanState } from './ports';
import { identity, participant, requireValue, text } from './rules';
import { transition } from './transitions';
import {planningCommand, applyPlanningCommand, attachReference} from './planning-commands';
import {plan, setStage, validatePlan, terminal} from './planning';
import {executable} from './configuration';
import {validateCandidates} from './identity';
import {archiveExpired} from './archives';

export function reduce(state: KanbanState, command: KanbanCommand, actor: KanbanActor,
    operationId: string, now: number, token: string, workflowInternal = false, restartReferences?: import('./ports').KanbanModuleOptions['restartReferences']): KanbanState {
    requireValue(state.board.deletedAt === undefined, 'BOARD_DELETED');
    numberEntities(state);
    protectStoppedBoard(state,command);
    if ('itemId' in command && command.itemId) requireValue(state.board.items.find(i => i.id === command.itemId)?.deletedAt === undefined, 'ITEM_DELETED');
    if (!workflowInternal) protectWorkflowItem(state, command);
    const board = state.board;
    if (command.type === 'delete-board') return deleteBoard(state, actor, operationId, now);
    if (command.type === 'scan') { scan(state, actor, operationId, now); refreshReady(state); return state; }
    let recordEvent = command.type !== 'renew';
    if (command.type === 'request-board-stop' || command.type === 'observe-board-stop') stopBoard(state,command,actor,now);
    else if (command.type === 'set-board-control') setBoardControl(state, command, actor, now, token);
    else if (command.type === 'delete-item') {
        const item = itemFor(board, command.itemId);
        requireValue(principal(actor).kind === 'human', 'FORBIDDEN');
        requireValue(terminal(item), 'ITEM_DELETE_REQUIRES_CLOSED');
        delete item.owner; delete item.transfer;
        item.deletedAt = now; item.updatedAt = now; item.revision++;
    }
    else if (command.type === 'restart-item') {
        createItem(state, restartItemInput(state, command, actor, restartReferences), actor, now, token);
        state.board.items.find(item => item.id === command.replacementId)!.restartedFrom = command.itemId;
    }
    else if (taskCommand(command)) applyTaskCommand(state, command, actor, now);
    else if (isWorkflowCommand(command)) recordEvent = applyWorkflow(state, command, actor, now, (inner, owner = actor) => {reduce(state,inner,owner,operationId,now,token,true,restartReferences);});
    else if (command.type === 'apply-discovery') applyDiscovery(state, command.batch, actor, now);
    else if (isRecordCommand(command)) applyRecord(state, command, actor, now);
    else if (command.type === 'review-amendment') {if(command.accept)assertDefinitionEditable(itemFor(board,command.itemId),now);reviewAmendment(board, command, actor, now);}
    else if (planningCommand(command)) applyPlanningCommand(state, command, now, actor, workflowInternal);
    else if (command.type === 'create-item') createItem(state, command, actor, now, token);
    else if (command.type === 'configure-automation') configureAutomation(board, command.settings, actor);
    else if (command.type === 'register-session') {
        const item = command.itemId ? itemFor(board, command.itemId) : undefined;
        const list = item ? item.participants : board.participants;
        participant(list, command.sessionId, command.agentId, command.role, command.subscribed, now);
        if (item) item.revision++;
    } else if (command.type === 'message') {
        text(command.message); command.recipientSessionIds.forEach(identity);
        if (command.itemId) itemFor(board, command.itemId);
        requireValue(command.recipientSessionIds.every(id => related(board).includes(id)), 'UNKNOWN_RECIPIENT');
    } else transition(state, itemFor(board, command.itemId), command, actor, now, token);
    numberEntities(state); refreshReady(state);
    board.revision++;
    if (recordEvent) append(state, actor, operationId, now, command.type, command.type === 'restart-item' ? command.replacementId : 'itemId' in command ? command.itemId : command.type === 'create-item' ? command.item.id ?? state.board.items.at(-1)?.id : 'dispatchId' in command ? state.workflow?.dispatches[command.dispatchId]?.itemId : undefined,
        eventData(command, state),
        command.type === 'message' ? command.recipientSessionIds : undefined);
    scan(state, actor, operationId, now);
    return state;
}
function createItem(state: KanbanState, command: Extract<KanbanCommand, { type: 'create-item' }>, actor: KanbanActor, now: number, token: string): void {
    const {id: requestedId, title, responsibility, acceptance, eligibleAgentIds, eligiblePrincipals, externalRefs,purpose} = command.item;
    const id = requestedId ?? allocateTaskId(state);
    const input = {id, title, responsibility, acceptance, eligibleAgentIds, eligiblePrincipals, externalRefs,purpose}, board = state.board;
    requireValue(purpose===undefined||purpose==='planning','INVALID_ITEM_PURPOSE');
    identity(input.id); text(input.title); text(input.responsibility); text(input.acceptance);
    requireValue(!board.items.some(i => i.id === input.id) && !state.archiveIndex?.some(i => i.id === input.id), 'ITEM_EXISTS');
    const item: KanbanItem = { ...input, origin: {kind: 'direct', principal: principal(actor)}, status: 'backlog', revision: 1, createdAt: now, readyAt: now, updatedAt: now, workUnits: 0, participants: [] };
    item.launch = {startAt: now + (purpose==='planning'?0:TASK_START_DELAY_MS)};
    requireValue(command.launch?.mode === undefined || ['automatic', 'manual'].includes(command.launch.mode), 'INVALID_LAUNCH_MODE');
    requireValue(command.launch?.paused === undefined || typeof command.launch.paused === 'boolean', 'INVALID_TASK_PAUSE');
    if (command.launch?.mode) item.launch!.mode = command.launch.mode;
    if (command.launch?.paused) item.control = {id: 'initial-' + token, action: 'pause', state: 'paused'};
    item.planning = command.planning ?? {...plan(item), kind: board.defaultWorkType ?? 'task'};
    const references = item.externalRefs ?? []; item.externalRefs = [];
    for (const reference of references) attachReference(item, reference);
    validateCandidates(board, item, executable(board, item)); validatePlan(state, item, item.planning);
    if(item.planning.parentId) {
        const parent=board.items.find(parent=>parent.id===item.planning!.parentId)!;
        if(parent.planning?.execution!=='children') {parent.planning={...plan(parent),execution:'children'};parent.updatedAt=now;parent.revision++;}
    }
    if (actor.sessionId) participant(item.participants, actor.sessionId, actor.agentId, 'creator', true, now); board.items.push(item);
    if (command.stage === 'open') setStage(state, item, 'open', now);
}
function itemFor(board: KanbanBoard, id: string): KanbanItem {
    const item = board.items.find(value => value.id === id); requireValue(item, 'ITEM_NOT_FOUND'); return item;
}
export function related(board: KanbanBoard): string[] {
    return [...new Set([...board.participants, ...board.items.flatMap(i => i.participants)].map(p => p.sessionId))];
}
function append(state: KanbanState, actor: KanbanActor, operationId: string, at: number, kind: string,
    itemId?: string, data: KanbanEvent['data'] = {}, recipients?: string[]): void {
    const archived = state.archiveWrites?.flatMap(write => write.value?.item.participants ?? []) ?? [];
    const members = [...archived, ...state.board.participants, ...state.board.items.filter(i => i.id === itemId).flatMap(i => i.participants)];
    state.events.push({ sequence: ++state.sequence, boardId: state.board.id, itemId, operationId, at, kind, actor,
        recipients: [...new Set(recipients ?? members.filter(p => p.subscribed).map(p => p.sessionId))], data });
}
function scan(state: KanbanState, actor: KanbanActor, operationId: string, now: number): void {
    for (const item of state.board.items) {
        if(initializeTaskLaunch(state,item)) {state.board.revision++;append(state,actor,operationId,now,'task-launch-initialized',item.id,{code:'LEGACY_LAUNCH_INITIALIZED'});}
        if (terminal(item)) continue;
        for (const reason of escalationReasons(state.board, item, now)) {
            const epoch = reason === 'transfer-timeout' ? item.transfer?.id : reason === 'backlog-review' ? item.updatedAt : item.owner?.token ?? item.readyAt;
            const key = JSON.stringify([item.id, epoch, reason]);
            if (state.escalations.includes(key)) continue;
            state.escalations.push(key); state.board.revision++;
            append(state, actor, operationId, now, 'escalated', item.id, { reason }, state.board.policy.escalationSessionIds);
        }
        if (item.transfer && item.transfer.expiresAt <= now) { delete item.transfer; item.revision++; item.updatedAt = now; state.board.revision++; }
    }
    const archived = archiveExpired(state, now);
    if (archived.length) {state.board.revision++; append(state, actor, operationId, now, 'items.archived', undefined, {reason: 'retention-policy'});}
}
export function escalationReasons(board: KanbanBoard, item: KanbanItem, now: number): string[] {
    const p = board.policy, result: string[] = [];
    if (item.status === 'backlog' && p.backlogReviewMs && now - item.updatedAt >= p.backlogReviewMs) result.push('backlog-review');
    if (item.planning?.dueAt !== undefined && now >= item.planning.dueAt) result.push('due-date');
    if (item.blocked && now - item.blocked.at >= p.progressTimeoutMs) result.push('blocked-age');
    if (!item.blocked && item.status === 'open' && now - item.readyAt >= p.claimTimeoutMs) result.push('unclaimed');
    if (item.status === 'review' && now - item.updatedAt >= p.progressTimeoutMs) result.push('review-timeout');
    if (item.transfer && now >= item.transfer.expiresAt) result.push('transfer-timeout');
    if (item.status !== 'claimed' || !item.owner) return result;
    if (now >= item.owner.leaseUntil) result.push('lease-expired');
    if (now - (item.progressAt ?? item.owner.claimedAt) >= p.progressTimeoutMs) result.push('no-progress');
    if (now - item.owner.claimedAt >= Math.min(item.estimate?.durationMs ?? p.maxDurationMs, p.maxDurationMs)) result.push('execution-timeout');
    if ((item.estimate?.complexity ?? 0) >= p.maxComplexity) result.push('complexity-threshold');
    if (Math.max(item.workUnits, item.estimate?.workUnits ?? 0) >= p.maxWorkUnits) result.push('work-threshold');
    if ((item.estimate?.durationMs ?? 0) >= p.maxDurationMs) result.push('duration-threshold');
    return result;
}

function eventData(command: KanbanCommand, state: KanbanState): KanbanEvent['data'] {
    if (command.type === 'request-board-stop' || command.type === 'observe-board-stop') return {code:state.board.lifecycle?.code,reason:state.board.lifecycle?.intent,itemIds:state.board.items.filter(item=>item.control?.action==='cancel').map(item=>item.id)};
    else if (command.type === 'set-board-control') return {code: 'BOARD_' + (state.board.executionControl?.paused ? 'PAUSE_REQUESTED' : state.board.executionControl?.mode?.toUpperCase())};
    if (command.type === 'apply-discovery') return discoveryEvent(state, command.batch);
    if (command.type === 'report-analysis') return {code:command.status.code, reason:'analysis-'+command.status.state};
    if (command.type === 'control-receipt') return {code:command.code, reason:'control-'+command.state};
    if (isWorkflowCommand(command)) return {readyItemIds:state.workflow?.ready, ...('dispatchId' in command ? {dispatchId:command.dispatchId} : {planId:command.plan.id}), ...('outcome' in command ? {reason:`execution-${command.outcome}`, code: command.code, status: state.board.items.find(item => item.id === state.workflow?.dispatches[command.dispatchId]?.itemId)?.status} : command.type === 'accept-execution' ? {reason: command.accept ? 'accepted' : 'rejected'} : {})};
    if (command.type === 'restart-item') return {itemIds:[command.itemId,command.replacementId],itemTitle:state.board.items.find(item=>item.id===command.replacementId)?.title};
    if (command.type === 'create-item') return {itemTitle: command.item.title};
    if (command.type === 'link-reference') return {reference: command.reference};
    if (command.type === 'block-item') return {reason: command.reason};
    if (command.type === 'release-item') return {reason: command.next === 'cancelled' ? 'cancelled' : 'released'};
    if (command.type === 'review') return {reason: command.accept ? 'accepted' : 'rejected',
        dispatchId: Object.values(state.workflow?.dispatches ?? {}).find(dispatch => dispatch.itemId === command.itemId && dispatch.outcome === 'succeeded')?.id};
    if (command.type === 'append-record') return {recordId: command.record.id, reason: command.record.kind === 'decision' ? 'decision-draft' : 'log'};
    if (command.type === 'review-record' || command.type === 'link-record') return {recordId: command.recordId};
    if (command.type === 'archive-items') return {itemIds: command.itemIds, reason: command.reason};
    if (command.type === 'cancel-item') return {reason: command.reason};
    if (command.type === 'plan-item') return {planning: command.planning};
    if (command.type === 'message') return { message: command.message };
    if (command.type === 'submit') return { resultRef: command.resultRef };
    if (command.type === 'claim' || command.type === 'accept-transfer') return { estimate: command.estimate };
    if (command.type === 'progress') return { estimate: command.estimate, workUnits: command.workUnits };
    return {};
}

function discoveryEvent(state: KanbanState, batch: import('./contracts').KanbanDiscoveryBatch): KanbanEvent['data'] {
    return {itemIds: batch.changes.map(change => change.itemId), recordIds: batch.records?.filter(record => state.records?.some(entry => entry.id === record.id && entry.originRunId === batch.runId)).map(record => record.id),
        ...(state.board.items.some(item => item.amendments?.some(proposal => proposal.runId === batch.runId && proposal.status === 'pending')) ? {reason: 'amendment-proposed'} : state.board.items.some(item => item.status === 'proposed' && item.origin?.runId === batch.runId) ? {reason: 'proposal-created'} : {})};
}

function deleteBoard(state: KanbanState, actor: KanbanActor, operationId: string, now: number): KanbanState {
    const owner = principal(actor), board = state.board;
    requireValue(owner.kind === 'human' && board.members?.some(member => member.kind === owner.kind && member.id === owner.id && member.roles?.includes('coordinator')), 'COORDINATOR_REQUIRED');
    requireValue(!board.items.some(item => !terminal(item) && (item.owner || item.transfer || item.status === 'claimed')), 'BOARD_EXECUTION_ACTIVE');
    requireValue(!Object.values(state.workflow?.dispatches ?? {}).some(dispatch => ['prepared', 'running', 'unknown', 'succeeded'].includes(dispatch.outcome)), 'BOARD_EXECUTION_UNSETTLED');
    requireValue(!board.items.some(item => item.control?.action === 'cancel' && item.control.state !== 'cancelled' && !terminal(item)), 'BOARD_CONTROL_UNSETTLED');
    board.deletedAt = now; board.revision++;
    if (board.automation) board.automation.enabled = false;
    if (state.workflow) state.workflow.ready = [];
    append(state, actor, operationId, now, 'delete-board');
    return state;
}
