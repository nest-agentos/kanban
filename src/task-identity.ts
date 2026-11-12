import type {KanbanTaskType} from './contracts/task-type';

/** Repair the historical contradictory identity in memory; reads never rewrite storage. */
export function restoreTaskIdentity<T extends {taskType?:KanbanTaskType;purpose?:string;planning?:{execution?:string}}>(item:T):T {
    if(item.taskType==='execution'&&(item.purpose==='planning'||item.planning?.execution==='children'))item.taskType='coordination';
    return item;
}
