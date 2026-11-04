import type {KanbanAutomationSettings, KanbanBoard, KanbanActor, KanbanMember} from './contracts';
import {identity, requireValue, validateBoard} from './rules';

/** Configuration grants no host authority; every execution still requires host admission. */
export function configureAutomation(board: KanbanBoard, settings: KanbanAutomationSettings, actor: KanbanActor): void {
    requireValue(settings && typeof settings.enabled === 'boolean' && typeof settings.autoAccept === 'boolean', 'INVALID_AUTOMATION');
    for (const ref of [settings.planner, settings.executor, ...(settings.preparation ? [settings.preparation] : [])]) {
        requireValue(ref && typeof ref === 'object', 'INVALID_AUTOMATION_TARGET');
        identity(ref.system); identity(ref.id); identity(ref.revision ?? '');
    }
    validateOptions(settings.preparationOptions);
    requireValue(settings.preparation || !Object.keys(settings.preparationOptions ?? {}).length, 'PREPARATION_REQUIRED');
    const members: KanbanMember[] = [...(board.members ?? []), ...(board.agents ?? []).filter(agent =>
        !board.members?.some(member => member.kind === 'agent' && member.id === agent.agentId))
        .map(agent => ({kind: 'agent' as const, id: agent.agentId, responsibility: agent.responsibility}))];
    for (const [principal, role] of [[settings.coordinator, 'coordinator'], [settings.worker, 'worker']] as const) {
        requireValue(principal && ['agent', 'human', 'service'].includes(principal.kind), 'INVALID_PRINCIPAL'); identity(principal.id);
        const existing = members.find(member => member.kind === principal.kind && member.id === principal.id);
        if (existing) existing.roles = [...new Set([...(existing.roles ?? []), role])];
        else members.push({...principal, responsibility: role, roles: [role]});
    }
    addReviewer(members, actor);
    board.members = members; delete board.agents; board.automation = structuredClone(settings);
    board.policy.review = settings.autoAccept ? 'assignee' : 'independent';
    validateBoard(board);
}
function addReviewer(members: KanbanMember[], actor: KanbanActor): void {
    if (actor.kind !== 'human' || !actor.id) return;
    const existing = members.find(member => member.kind === 'human' && member.id === actor.id);
    if (existing) existing.roles = [...new Set([...(existing.roles ?? []), 'reviewer' as const, 'coordinator' as const])];
    else members.push({kind: 'human', id: actor.id, responsibility: 'Review work', roles: ['reviewer', 'coordinator']});
}

function validateOptions(options: Record<string, string> | undefined): void {
    if (options === undefined) return;
    requireValue(options && typeof options === 'object' && !Array.isArray(options) && Object.keys(options).length <= 16, 'INVALID_PREPARATION_OPTIONS');
    for (const [key, value] of Object.entries(options)) {
        requireValue(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) && typeof value === 'string' && value.length <= 4096, 'INVALID_PREPARATION_OPTIONS');
    }
}
