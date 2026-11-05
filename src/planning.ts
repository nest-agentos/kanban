import type {KanbanItem, KanbanItemSummary, KanbanPlanning} from './contracts';
import type {KanbanState} from './ports';
import {workType, executable} from './configuration';
import {identity, requireValue, text} from './rules';

export function plan(item: KanbanItem): KanbanPlanning {
    return item.planning ?? {kind: 'task', priority: 2, dependencies: [], references: []};
}
export function summary(item: KanbanItem): KanbanItemSummary {
    return {deletedAt:item.deletedAt, launch:item.launch, analysis:item.analysis, control:item.control, issues:item.issues, blocked:item.blocked, id: item.id, number: item.number, title: item.title, status: item.status, revision: item.revision, createdAt: item.createdAt,
        updatedAt: item.updatedAt, discoveryFingerprint: item.origin?.fingerprint, pendingAmendments: item.amendments?.filter(proposal => proposal.status === 'pending').length, externalRefs: item.externalRefs, closedAt: item.closedAt, planning: plan(item), sessionIds: item.participants.map(p => p.sessionId)};
}
export function terminal(item: Pick<KanbanItem, 'status'>): boolean {return item.status === 'completed' || item.status === 'cancelled';}
export function catalog(state: KanbanState): KanbanItemSummary[] {return [...state.board.items.map(summary), ...(state.archiveIndex ?? [])];}
export function limits(state: KanbanState) {
    const p = state.board.policy;
    return {ready: p.maxReady ?? 20, inProgress: p.maxInProgress ?? 3, perAgent: p.maxInProgressPerAssignee ?? p.maxInProgressPerAgent ?? 1, perAssignee: p.maxInProgressPerAssignee ?? p.maxInProgressPerAgent ?? 1};
}
export function validatePlan(state: KanbanState, item: KanbanItem, value: KanbanPlanning): void {
    requireValue(typeof value.kind === 'string' && Number.isInteger(value.priority) && value.priority >= 0 && value.priority <= 4, 'INVALID_PLANNING');
    requireValue(Array.isArray(value.dependencies) && value.dependencies.length <= 100 && Array.isArray(value.references) && value.references.length <= 100, 'PLANNING_LIMIT');
    value.dependencies.forEach(identity); value.references.forEach(text);
    if (value.area !== undefined) identity(value.area); if (value.milestone !== undefined) identity(value.milestone);
    requireValue(value.execution===undefined||['direct','children'].includes(value.execution),'INVALID_EXECUTION_MODE');
    const type = workType(state.board, value.kind);
    if (value.dueAt !== undefined) requireValue(Number.isFinite(value.dueAt) && value.dueAt >= 0, 'INVALID_DUE_DATE');
    const all = catalog(state), parent = all.find(i => i.id === value.parentId);
    if (value.parentId) {
        identity(value.parentId); requireValue(parent && !parent.archivedAt && !parent.deletedAt && !terminal(parent) && parent.control?.action !== 'cancel' && !['claimed','review'].includes(parent.status), 'PARENT_UNAVAILABLE');
        requireValue(parent.id !== item.id && workType(state.board, parent.planning.kind).rank < type.rank, 'INVALID_PARENT_KIND');
    }
    requireValue(value.execution==='children'||!all.some(child=>child.planning.parentId===item.id),'CHILDREN_REQUIRE_AGGREGATION');
    requireValue(!all.some(child => child.planning.parentId === item.id && workType(state.board, child.planning.kind).rank <= type.rank), 'INVALID_CHILD_KIND');
    for (const id of value.dependencies) requireValue(id !== item.id && all.some(i => i.id === id), 'INVALID_DEPENDENCY');
    const visited = new Set<string>(), pending = [...value.dependencies];
    while (pending.length) {
        const id = pending.pop()!; requireValue(id !== item.id, 'DEPENDENCY_CYCLE');
        if (visited.has(id)) continue; visited.add(id);
        pending.push(...(all.find(i => i.id === id)?.planning.dependencies ?? []));
    }
}
export function assertReady(state: KanbanState, item: KanbanItem): void {
    requireValue(!state.board.lifecycle,'BOARD_STOPPING');
    requireValue(!state.board.executionControl?.paused,'BOARD_EXECUTION_PAUSED');
    requireValue(executable(state.board, item), 'PLAN_NOT_EXECUTABLE');
    requireValue(!item.blocked, 'ITEM_BLOCKED');
    requireValue(!item.control || item.control.action === 'resume' && item.control.state === 'resumed', 'TASK_CONTROL_PENDING');
    const all = catalog(state);
    requireValue(plan(item).dependencies.every(id => all.find(i => i.id === id)?.status === 'completed'), 'DEPENDENCIES_UNFINISHED');
}
export function setStage(state: KanbanState, item: KanbanItem, stage: 'backlog' | 'open', now: number): void {
    requireValue(['proposed', 'backlog', 'open'].includes(item.status), 'ITEM_NOT_PLANNABLE');
    requireValue(stage === 'backlog' || stage === 'open', 'INVALID_STAGE');
    if (stage === 'open') {
        assertReady(state, item);
        requireValue(item.status === 'open' || state.board.items.filter(i => i.status === 'open').length < limits(state).ready, 'READY_LIMIT');
    }
    item.status = stage; item.readyAt = now; item.updatedAt = now; item.revision++;
}

export function automaticStage(state: KanbanState, item: KanbanItem): 'open' | 'backlog' {
    const all = catalog(state);
    const dependenciesComplete = plan(item).dependencies.every(id => all.find(i => i.id === id)?.status === 'completed');
    return executable(state.board, item) && !item.blocked && dependenciesComplete && state.board.items.filter(i => i.status === 'open').length < limits(state).ready ? 'open' : 'backlog';
}
