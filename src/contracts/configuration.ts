import type {KanbanItem, KanbanBoard} from './contracts';

export interface KanbanPrincipal {kind: 'agent' | 'human' | 'service'; id: string}
export interface KanbanMember extends KanbanPrincipal {
    responsibility: string; roles?: Array<'worker' | 'reviewer' | 'coordinator'>;
}
export interface KanbanWorkType {id: string; label: string; rank: number; executable: boolean}
export interface KanbanColumn {id: string; label: string; states: KanbanItem['status'][]}
export interface KanbanNotificationPolicy {rules?: Record<string, 'info' | 'error' | 'none'>}
export const DEFAULT_KANBAN_WORK_TYPES: readonly KanbanWorkType[] = [
    {id: 'initiative', label: 'Goal', rank: 0, executable: false},
    {id: 'feature', label: 'Group', rank: 1, executable: false},
    {id: 'task', label: 'Action', rank: 2, executable: true},
    {id: 'fix', label: 'Fix', rank: 2, executable: true},
    {id: 'subtask', label: 'Subtask', rank: 3, executable: true},
];

export interface KanbanExternalReference {system: string; id: string; revision?: string}

/** A composite work item delegates execution to its children. */
export function executableWorkItem(board:Pick<KanbanBoard,'workTypes'|'defaultWorkType'>, item:{planning?:{kind:string;execution?:'direct'|'children'}}):boolean {
    return item.planning?.execution!=='children'&&(board.workTypes??DEFAULT_KANBAN_WORK_TYPES)
        .some(type=>type.id===(item.planning?.kind??board.defaultWorkType??'task')&&type.executable);
}
