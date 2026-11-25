import {kanbanTaskType,type KanbanTaskType} from './task-type';
import type {KanbanBoard} from './contracts';

export interface KanbanReferenceTarget {boardId: string; itemId?: string; recordId?: string; reference: string; scope: KanbanBoard['scope']}
type TaskReference = {id:string;recurring?:true;taskType?:KanbanTaskType;purpose?:string;planning?:{execution?:string;parentId?:string}};

export function kanbanReference(board: {id: string; number?: number}, entity?: TaskReference & {number?:number;kind?:'log'|'decision'}): string {
    const prefix = board.number ? `KB-${board.number}` : board.id;
    if (!entity) return prefix;
    if (!entity.number) return `${prefix}/${entity.id}`;
    const type=entity.kind?(entity.kind==='log'?'L':'D'):taskReferenceType(entity);
    return board.number?`KB${type}-${board.number}-${entity.number}`:`${prefix}/${entity.id}`;
}

// Recurring management IDs are derived from the durable round ID at creation.
export function isRecurringTask(entity:TaskReference): boolean {
    return entity.recurring === true || /^work-round-[a-f0-9]{64}-0$/.test(entity.planning?.parentId ?? entity.id);
}

function taskReferenceType(entity:TaskReference): string {
    const type = kanbanTaskType(entity) === 'coordination' ? 'C' : 'T';
    return isRecurringTask(entity) ? 'L' + type : type;
}
