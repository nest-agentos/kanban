import type { KanbanActor, KanbanBoard, KanbanEstimate, KanbanItem, KanbanParticipant } from './contracts';
import {validateConfiguration} from './configuration';
import {sameOwner} from './identity';
import { KanbanError } from './ports';

export function requireValue(condition: unknown, code: string): asserts condition {
    if (!condition) throw new KanbanError(code);
}
export function text(value: string): void { requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= 8000, 'INVALID_TEXT'); }
export function identity(value: string): void { requireValue(typeof value === 'string' && value.length > 0 && value.length <= 256 && !['__proto__', 'prototype', 'constructor'].includes(value), 'INVALID_ID'); }
export function positive(value: number): void { requireValue(Number.isFinite(value) && value > 0, 'INVALID_THRESHOLD'); }
export function validateEstimate(estimate: KanbanEstimate): void {
    positive(estimate.complexity); positive(estimate.workUnits); positive(estimate.durationMs);
    requireValue(['low', 'medium', 'high'].includes(estimate.confidence), 'INVALID_CONFIDENCE');
}
export function validateBoard(board: KanbanBoard): void {
    identity(board.id); text(board.title);
    requireValue(['system', 'project', 'collection'].includes(board.scope.kind), 'INVALID_SCOPE');
    if (board.scope.kind === 'project') identity(board.scope.projectId);
    if (board.scope.kind === 'collection') {identity(board.scope.namespace); identity(board.scope.id);}
    validateConfiguration(board);
    for (const agent of board.agents ?? []) { identity(agent.agentId); text(agent.responsibility); }
    requireValue(new Set((board.agents ?? []).map(a => a.agentId)).size === (board.agents ?? []).length, 'DUPLICATE_AGENT');
    const p = board.policy;
    for (const value of [p.maxReady, p.maxInProgress, p.maxInProgressPerAgent, p.maxInProgressPerAssignee]) if (value !== undefined) requireValue(Number.isSafeInteger(value) && value > 0, 'INVALID_LIMIT');
    requireValue(p.maxInProgressPerAgent === undefined || p.maxInProgressPerAssignee === undefined || p.maxInProgressPerAgent === p.maxInProgressPerAssignee, 'POLICY_LIMIT_CONFLICT');
    for (const value of [p.archiveAfterMs, p.backlogReviewMs]) if (value !== undefined) positive(value);
    for (const value of [p.claimTimeoutMs, p.leaseMs, p.progressTimeoutMs, p.transferTimeoutMs,
        p.maxComplexity, p.maxWorkUnits, p.maxDurationMs]) positive(value);
    requireValue(Array.isArray(p.escalationSessionIds), 'INVALID_ESCALATION_TARGETS');
    requireValue(p.review === undefined || ['independent', 'assignee'].includes(p.review), 'INVALID_REVIEW_POLICY');
    requireValue(p.requireEstimate === undefined || typeof p.requireEstimate === 'boolean', 'INVALID_ESTIMATE_POLICY');
    p.escalationSessionIds.forEach(identity);
}
export function participant(list: KanbanParticipant[], sessionId: string, agentId: string | undefined,
    role: KanbanParticipant['roles'][number], subscribed: boolean, now: number): void {
    identity(sessionId);
    requireValue(['creator', 'owner', 'consultant', 'reviewer', 'observer', 'escalation'].includes(role), 'INVALID_ROLE');
    let entry = list.find(value => value.sessionId === sessionId);
    if (!entry) { entry = { sessionId, agentId, roles: [], subscribed, joinedAt: now }; list.push(entry); }
    if (entry.agentId && agentId) requireValue(entry.agentId === agentId, 'SESSION_AGENT_CONFLICT');
    entry.agentId ??= agentId;
    if (!entry.roles.includes(role)) entry.roles.push(role);
    entry.subscribed = subscribed;
}
export function owned(item: KanbanItem, actor: KanbanActor, token: string, now: number): void {
    requireValue(item.status === 'claimed', 'ITEM_NOT_RUNNING');
    requireValue(item.owner && sameOwner(item.owner, actor) && item.owner.token === token, 'OWNER_MISMATCH');
    requireValue(item.owner.leaseUntil > now, 'LEASE_EXPIRED');
}
