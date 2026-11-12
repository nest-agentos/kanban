import type {KanbanItemSummary} from './planning';
import {kanbanTaskType} from './task-type';

/** Board placement reflects child evidence without rewriting lifecycle facts. */
export function kanbanColumnStatus(item:KanbanItemSummary):KanbanItemSummary['status'] {
    if(kanbanTaskType(item)!=='coordination'||['completed','cancelled'].includes(item.status))return item.status;
    const phase=item.task?.phase;
    if(phase==='review')return 'review';
    if(phase&&['running','preparing','analyzing','waiting-input','error','unknown','pausing','paused','resuming','cancelling'].includes(phase))return 'claimed';
    return item.status;
}
/** User participation precedes background execution and waiting. */
export function kanbanAttentionRank(item:Pick<KanbanItemSummary,'task'>):number {
    const phase=item.task?.phase;
    return phase==='waiting-input'?0:phase==='unknown'?1:phase==='error'?2:phase==='review'?3:phase==='running'?4:5;
}
