import type {KanbanItemSummary,KanbanRecordSummary} from './contracts';
import type {KanbanState} from './ports';
import {projectKanbanTask} from './contracts/task-projection';

/** Attention is a read projection from existing indexes, never a second notification store. */
export function attentionCounts(state:KanbanState,items:KanbanItemSummary[],records:KanbanRecordSummary[]) {
    const active=items.filter(item=>item.deletedAt===undefined&&item.archivedAt===undefined);
    const needs=(item:KanbanItemSummary)=>['waiting-input','error','unknown','review'].includes(projectKanbanTask(item,state.workflow,Date.now(),items).phase);
    const projected=recordAttention(state,items,records);
    return {board:active.filter(item=>item.purpose!=='planning'&&item.planning.execution!=='children'&&needs(item)).length,
        decision:projected.filter(record=>record.kind==='decision'&&record.attention).length,
        log:projected.filter(record=>record.kind==='log'&&record.attention).length};
}

export function recordAttention(state:KanbanState,items:KanbanItemSummary[],records:KanbanRecordSummary[]):KanbanRecordSummary[] {
    const phases=new Map(items.filter(item=>item.deletedAt===undefined&&item.archivedAt===undefined&&item.purpose==='planning').map(item=>[item.id,projectKanbanTask(item,state.workflow).phase]));
    const children=new Map<string,string[]>();for(const item of items)if(item.planning.parentId)children.set(item.planning.parentId,[...children.get(item.planning.parentId)??[],item.id]);
    return records.map(record=>{
        const ids=new Set(record.itemIds);for(const id of ids)for(const child of children.get(id)??[])ids.add(child);
        const pending=[...ids].map(id=>phases.get(id));
        const attention=record.deletedAt!==undefined||record.archivedAt!==undefined?undefined:record.status==='draft'?'review'
            :pending.includes('waiting-input')?'waiting-input':pending.some(phase=>phase==='error'||phase==='unknown')?'error':undefined;
        return {...record,attention};
    });
}
