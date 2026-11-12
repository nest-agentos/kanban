export type KanbanTaskType='coordination'|'execution';
/** Semantic task responsibility is independent of customizable work-type ranks. */
export function kanbanTaskType(item:{taskType?:KanbanTaskType;purpose?:string;planning?:{execution?:string}}):KanbanTaskType {
    return item.taskType??(item.planning?.execution==='children'||item.purpose==='planning'?'coordination':'execution');
}
