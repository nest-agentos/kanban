import {kanbanTaskType,type KanbanTaskType} from './task-type';
import type {KanbanBoard} from './contracts';

export interface KanbanReferenceTarget {boardId: string; itemId?: string; recordId?: string; reference: string; scope: KanbanBoard['scope']}
export function kanbanReference(board: {id: string; number?: number}, entity?: {id: string; number?: number; kind?: 'log' | 'decision';taskType?:KanbanTaskType;purpose?:string;planning?:{execution?:string}}): string {
    const prefix = board.number ? `KB-${board.number}` : board.id;
    if (!entity) return prefix;
    if (!entity.number) return `${prefix}/${entity.id}`;
    const type=entity.kind?(entity.kind==='log'?'L':'D'):(kanbanTaskType(entity)==='coordination'?'C':'T');
    return board.number?`KB${type}-${board.number}-${entity.number}`:`${prefix}/${entity.id}`;
}
