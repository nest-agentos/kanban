import {DEFAULT_KANBAN_WORK_TYPES, executableWorkItem} from './contracts';
import type {KanbanBoard, KanbanPolicy, KanbanWorkType} from './contracts';
import {identity, requireValue, text} from './rules';
import {principalKey, roster} from './identity';

export function policy(input: Partial<KanbanPolicy> = {}): KanbanPolicy {
    return {claimTimeoutMs: 86400000, leaseMs: 600000, progressTimeoutMs: 3600000, transferTimeoutMs: 1800000,
        maxComplexity: 10, maxWorkUnits: 100, maxDurationMs: 28800000, escalationSessionIds: [], ...input};
}
export function workTypes(board: KanbanBoard): readonly KanbanWorkType[] {return board.workTypes ?? DEFAULT_KANBAN_WORK_TYPES;}
export function workType(board: KanbanBoard, id: string): KanbanWorkType {
    const found = workTypes(board).find(type => type.id === id); requireValue(found, 'UNKNOWN_WORK_TYPE'); return found;
}
export function executable(board: KanbanBoard, item: {planning?: {kind: string; execution?: 'direct'|'children'}}): boolean {
    workType(board, item.planning?.kind ?? board.defaultWorkType ?? 'task');
    return executableWorkItem(board,item);
}
export function validateConfiguration(board: KanbanBoard): void {
    const types = workTypes(board); requireValue(types.length > 0 && types.length <= 20, 'WORK_TYPE_LIMIT');
    requireValue(new Set(types.map(t => t.id)).size === types.length, 'DUPLICATE_WORK_TYPE');
    for (const type of types) {
        identity(type.id); text(type.label); requireValue(Number.isInteger(type.rank) && type.rank >= 0 && type.rank <= 9 && typeof type.executable === 'boolean', 'INVALID_WORK_TYPE');
    }
    workType(board, board.defaultWorkType ?? 'task');
    const members = roster(board); requireValue(members.length > 0, 'MEMBER_ROSTER_REQUIRED');
    requireValue(new Set(members.map(principalKey)).size === members.length, 'DUPLICATE_MEMBER');
    for (const member of members) {identity(member.id); requireValue(['agent', 'human', 'service'].includes(member.kind), 'INVALID_PRINCIPAL');}
    for (const member of board.members ?? []) {
        text(member.responsibility); requireValue(!member.roles || member.roles.every(r => ['worker', 'reviewer', 'coordinator'].includes(r)), 'INVALID_MEMBER_ROLE');
    }
    validateColumns(board);
    for (const [kind, value] of Object.entries(board.notifications?.rules ?? {}))
        requireValue(/^[a-z][a-z0-9.-]{0,79}$/.test(kind) && ['info', 'error', 'none'].includes(value), 'INVALID_NOTIFICATION_RULE');
}
function validateColumns(board: KanbanBoard): void {
    if (!board.columns) return;
    const states = board.columns.flatMap(c => c.states);
    requireValue(states.length === 7 && new Set(states).size === 7 && ['proposed', 'backlog', 'open', 'claimed', 'review', 'completed', 'cancelled'].every(s => states.includes(s as never)), 'INVALID_COLUMNS');
    requireValue(new Set(board.columns.map(c => c.id)).size === board.columns.length, 'DUPLICATE_COLUMN');
    for (const column of board.columns) {identity(column.id); text(column.label); requireValue(column.states.length > 0, 'EMPTY_COLUMN');}
}
