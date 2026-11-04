import {taskEditing} from './contracts/task-projection';
import type {KanbanActor, KanbanBoard, KanbanCommand, KanbanItem, KanbanPrincipal} from './contracts';
import type {KanbanState} from './ports';
import type {PlanningCommand} from './planning-commands';
import {assertReady, limits, catalog, terminal} from './planning';
import {eligible, principal, principalKey, assigneeKey, candidates} from './identity';
import {owned, participant, requireValue, text, validateEstimate} from './rules';

type ItemCommand = Exclude<KanbanCommand, import('./contracts').KanbanTaskCommand | import('./contracts').KanbanWorkflowCommand | PlanningCommand | {type: 'set-board-control' | 'delete-board' | 'append-record' | 'review-record' | 'link-record' | 'review-amendment' | 'configure-automation'} | {type: 'create-item' | 'register-session' | 'message' | 'scan' | 'apply-discovery' | 'publish-proposal'}>;
export function transition(state: KanbanState, item: KanbanItem, command: ItemCommand, actor: KanbanActor, now: number, token: string): void {
    requireValue(item.status !== 'completed' && item.status !== 'cancelled', 'ITEM_COMPLETED');
    if (command.type === 'claim' || command.type === 'accept-transfer') claim(state, item, command, actor, now, token);
    else if (command.type === 'review') review(state, item, command.accept, actor, now);
    else {
        owned(item, actor, command.token, now);
        if (command.type === 'submit') requireValue(catalog(state).filter(i => i.planning.parentId === item.id).every(terminal), 'CHILDREN_UNFINISHED');
        ownerUpdate(state.board, item, command, now, token);}
    if (command.type !== 'renew') {item.revision++; item.updatedAt = now;}
}
function claim(state: KanbanState, item: KanbanItem, command: Extract<ItemCommand, {type: 'claim' | 'accept-transfer'}>, actor: KanbanActor, now: number, token: string): void {
    const board = state.board, key = principalKey(principal(actor));
    requireValue(!taskEditing(item,now),'EDIT_LEASE_ACTIVE');
    eligible(board, item, actor); assertReady(state, item);
    requireValue(command.estimate || board.policy.requireEstimate === false, 'ESTIMATE_REQUIRED'); if (command.estimate) validateEstimate(command.estimate);
    const wip = board.items.filter(i => i.status === 'claimed' || i.status === 'review');
    if (command.type === 'claim') requireValue(wip.length < limits(state).inProgress, 'WIP_LIMIT');
    requireValue(wip.filter(i => i.id !== item.id && i.owner && assigneeKey(i.owner) === key).length < limits(state).perAssignee, principal(actor).kind === 'agent' ? 'AGENT_WIP_LIMIT' : 'ASSIGNEE_WIP_LIMIT');
    if (command.type === 'claim') requireValue(item.status === 'open' && !item.owner, 'ALREADY_OWNED');
    else {
        requireValue(item.status === 'claimed' && item.transfer && principalKey(transferTarget(item.transfer)) === key, 'TRANSFER_NOT_OFFERED');
        requireValue(item.transfer.expiresAt > now && item.owner && item.owner.leaseUntil > now, 'TRANSFER_EXPIRED');
        requireValue(assigneeKey(item.owner) !== key, 'SELF_TRANSFER');
    }
    item.owner = {...actor, principalId: key, token, claimedAt: now, leaseUntil: now + board.policy.leaseMs};
    item.estimate = command.estimate; item.status = 'claimed'; item.progressAt = now; delete item.transfer;
    if (actor.sessionId) participant(item.participants, actor.sessionId, actor.agentId, 'owner', true, now);
}
function review(state: KanbanState, item: KanbanItem, accept: boolean, actor: KanbanActor, now: number): void {
    requireValue(item.status === 'review', 'NOT_IN_REVIEW');
    const key = principalKey(principal(actor));
    const registered = actor.sessionId && item.participants.some(p => p.sessionId === actor.sessionId && p.roles.includes('reviewer'))
        || state.board.members?.some(m => principalKey(m) === key && m.roles?.includes('reviewer'));
    requireValue(registered, 'REVIEWER_REQUIRED');
    requireValue(!item.owner || assigneeKey(item.owner) !== key, 'INDEPENDENT_REVIEW_REQUIRED');
    item.status = accept ? 'completed' : state.board.items.filter(i => i.status === 'open').length < limits(state).ready ? 'open' : 'backlog';
    if (accept) item.closedAt = now;
    if (!accept) {delete item.owner; delete item.estimate; delete item.resultRef; item.readyAt = now;}
}
function ownerUpdate(board: KanbanBoard, item: KanbanItem, command: Exclude<ItemCommand, {type: 'claim' | 'accept-transfer' | 'review'}>, now: number, token: string): void {
    switch (command.type) {
        case 'renew': item.owner!.leaseUntil = now + board.policy.leaseMs; break;
        case 'progress':
            requireValue(Number.isFinite(command.workUnits) && command.workUnits >= item.workUnits, 'INVALID_WORK_UNITS');
            item.workUnits = command.workUnits; item.progressAt = now;
            if (command.estimate) {validateEstimate(command.estimate); item.estimate = command.estimate;} break;
        case 'request-transfer': requestTransfer(board, item, command, now, token); break;
        case 'submit':
            text(command.resultRef); item.resultRef = command.resultRef; item.status = board.policy.review === 'assignee' ? 'completed' : 'review';
            if (item.status === 'completed') item.closedAt = now; delete item.transfer; break;
    }
}
function requestTransfer(board: KanbanBoard, item: KanbanItem, command: Extract<ItemCommand, {type: 'request-transfer'}>, now: number, token: string): void {
    requireValue(Boolean(command.target) !== Boolean(command.agentId), 'TRANSFER_TARGET_REQUIRED');
    const target = command.target ?? {kind: 'agent' as const, id: command.agentId!}, key = principalKey(target);
    requireValue(candidates(board, item).some(p => principalKey(p) === key), 'AGENT_NOT_ELIGIBLE');
    requireValue(assigneeKey(item.owner!) !== key, 'SELF_TRANSFER'); requireValue(!item.transfer, 'TRANSFER_ALREADY_PENDING');
    item.transfer = {id: token, target, ...(target.kind === 'agent' ? {agentId: target.id} : {}), requestedAt: now, expiresAt: now + board.policy.transferTimeoutMs};
}
function transferTarget(value: NonNullable<KanbanItem['transfer']>): KanbanPrincipal {return value.target ?? {kind: 'agent', id: value.agentId!};}
