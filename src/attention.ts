import type {KanbanItemSummary,KanbanRecordSummary,KanbanTaskProjection} from './contracts';
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
    const phases=new Map(items.filter(item=>item.deletedAt===undefined&&item.archivedAt===undefined).map(item=>[item.id,projectKanbanTask(item,state.workflow,Date.now(),items)]));
    const byId=new Map(items.map(item=>[item.id,item]));
    const children=new Map<string,string[]>();for(const item of items)if(item.planning.parentId)children.set(item.planning.parentId,[...children.get(item.planning.parentId)??[],item.id]);
    return records.map(record=>{
        const ids=new Set(record.itemIds);for(const id of ids)for(const child of children.get(id)??[])ids.add(child);
        const attentionTasks=[...ids].flatMap(id=>pendingTask(byId.get(id),phases.get(id)));
        const pending=attentionTasks.map(task=>task.phase);
        const attention=record.deletedAt!==undefined||record.archivedAt!==undefined?undefined:record.status==='draft'?'review'
            :pending.includes('waiting-input')?'waiting-input':pending.some(phase=>phase==='error'||phase==='unknown')?'error':undefined;
        const target=attention?attentionTasks.find(task=>attention==='waiting-input'?task.phase==='waiting-input':attention==='error'?task.phase==='error'||task.phase==='unknown':false)?.itemId:undefined;
        const reason=target?phases.get(target)?.reason:undefined;
        return {...record,attentionTasks:record.archivedAt===undefined&&record.deletedAt===undefined?attentionTasks:[],attention,attentionItemId:target,attentionCode:reason&&/^[A-Z][A-Z0-9_]{0,79}$/.test(reason)?reason:undefined};
    });
}

function pendingTask(item:KanbanItemSummary|undefined,task:KanbanTaskProjection|undefined):NonNullable<KanbanRecordSummary['attentionTasks']>{
    if(!task||!item||!['waiting-input','error','unknown'].includes(task.phase))return [];
    const ownIssue=item.blocked||item.issues?.some(issue=>!issue.resolvedBy)||['failed','blocked','clarification','unknown'].includes(item.analysis?.state??'');
    if(item.planning.execution==='children'&&!ownIssue)return [];
    return [{itemId:item.id,title:item.title,phase:task.phase as 'waiting-input'|'error'|'unknown',purpose:item.purpose==='planning'||item.planning.execution==='children'?'planning':'execution',...(task.sessionId?{sessionId:task.sessionId}:{})}];
}
