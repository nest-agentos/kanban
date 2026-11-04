import type {KanbanBoard} from './contracts';

export interface KanbanReferenceTarget {boardId: string; itemId?: string; recordId?: string; reference: string; scope: KanbanBoard['scope']}
export function kanbanReference(board: {id: string; number?: number}, entity?: {id: string; number?: number; kind?: 'log' | 'decision'}): string {
    const prefix = board.number ? `KB-${board.number}` : board.id;
    if (!entity) return prefix;
    if (!entity.number) return `${prefix}/${entity.id}`;
    return entity.kind ? `${prefix}/${entity.kind === 'log' ? 'L' : 'D'}-${entity.number}` : `${prefix}#${entity.number}`;
}
