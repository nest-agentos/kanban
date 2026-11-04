import type {KanbanActor, KanbanAssignment, KanbanBoard, KanbanItem, KanbanPrincipal} from './contracts';
import {identity, requireValue} from './rules';

export function principal(actor: KanbanActor): KanbanPrincipal {
    const kind = actor.kind ?? 'agent', id = kind === 'agent' ? actor.agentId ?? actor.id : actor.id;
    requireValue(['agent', 'human', 'service'].includes(kind) && id, 'INVALID_ACTOR'); identity(id);
    if (kind === 'agent') {requireValue(!actor.agentId || !actor.id || actor.agentId === actor.id, 'ACTOR_ID_MISMATCH'); if (actor.sessionId !== undefined) identity(actor.sessionId); if (actor.taskId !== undefined) identity(actor.taskId);}
    return {kind, id};
}
export function principalKey(value: KanbanPrincipal): string {return JSON.stringify([value.kind, value.id]);}
export function assigneeKey(value: KanbanAssignment): string {
    return value.principalId ?? principalKey({kind: 'agent', id: value.agentId!});
}
export function sameOwner(owner: KanbanAssignment, actor: KanbanActor): boolean {
    const value = principal(actor);
    return assigneeKey(owner) === principalKey(value) && (value.kind !== 'agent' || owner.sessionId === actor.sessionId && owner.taskId === actor.taskId);
}
export function roster(board: KanbanBoard): KanbanPrincipal[] {
    return [...(board.agents ?? []).map(a => ({kind: 'agent' as const, id: a.agentId})), ...(board.members ?? [])];
}
export function candidates(board: KanbanBoard, item: KanbanItem): KanbanPrincipal[] {
    if (item.eligibleAgentIds === undefined && item.eligiblePrincipals === undefined)
        return [...(board.agents ?? []).map(a => ({kind: 'agent' as const, id: a.agentId})),
            ...(board.members ?? []).filter(m => !m.roles || m.roles.includes('worker'))];
    return [...(item.eligibleAgentIds ?? []).map(id => ({kind: 'agent' as const, id})), ...(item.eligiblePrincipals ?? [])];
}
export function eligible(board: KanbanBoard, item: KanbanItem, actor: KanbanActor): void {
    const key = principalKey(principal(actor));
    requireValue(candidates(board, item).some(p => principalKey(p) === key), actor.kind && actor.kind !== 'agent' ? 'ASSIGNEE_NOT_ELIGIBLE' : 'AGENT_NOT_ELIGIBLE');
}
export function validateCandidates(board: KanbanBoard, item: KanbanItem, executable: boolean): void {
    const allowed = new Set(roster(board).map(principalKey)), values = candidates(board, item);
    requireValue(!executable || values.length > 0, 'ELIGIBLE_ASSIGNEES_REQUIRED');
    for (const value of values) {
        identity(value.id); requireValue(['agent', 'human', 'service'].includes(value.kind), 'INVALID_PRINCIPAL');
        requireValue(allowed.has(principalKey(value)), value.kind === 'agent' ? 'AGENT_NOT_REGISTERED' : 'ASSIGNEE_NOT_REGISTERED');
    }
}

export function normalizeActor(actor: KanbanActor): KanbanActor {
    const value = principal(actor);
    return value.kind === 'agent' ? {agentId: value.id, sessionId: actor.sessionId, taskId: actor.taskId}
        : {kind: value.kind, id: value.id};
}
