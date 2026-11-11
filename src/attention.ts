import type {KanbanItemSummary,KanbanRecordSummary,KanbanTaskProjection} from './contracts';
import type {KanbanState} from './ports';
import {recordProgress} from './record-progress';
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
    const known=new Set(items.map(item=>item.id)),now=Date.now();
    const all=[...items,...(state.archiveIndex??[]).filter(row=>!known.has(row.id))];
    const byId=new Map(all.map(item=>[item.id,item]));
    const progressPhases=new Map(all.filter(item=>item.deletedAt===undefined).map(item=>[item.id,projectKanbanTask(item,state.workflow,now,all)]));
    const phases=new Map([...progressPhases].filter(([id])=>byId.get(id)?.archivedAt===undefined));
    const children=new Map<string,string[]>();for(const item of all)if(item.planning.parentId)children.set(item.planning.parentId,[...children.get(item.planning.parentId)??[],item.id]);
    return records.map(record=>{
        const roots=record.archivedAt===undefined?record.itemIds.filter(id=>byId.get(id)?.archivedAt===undefined):record.itemIds;
        const ids=new Set(roots.length?roots:record.itemIds);for(const id of ids)for(const child of children.get(id)??[])ids.add(child);
        const attentionTasks=[...ids].flatMap(id=>pendingTask(byId.get(id),phases.get(id)));
        const pending=attentionTasks.map(task=>task.phase);
        const attention=record.deletedAt!==undefined||record.archivedAt!==undefined?undefined:record.status==='draft'?'review'
            :pending.includes('waiting-input')?'waiting-input':pending.some(phase=>phase==='error'||phase==='unknown')?'error':undefined;
        const target=attention?attentionTasks.find(task=>attention==='waiting-input'?task.phase==='waiting-input':attention==='error'?task.phase==='error'||task.phase==='unknown':false)?.itemId:undefined;
        const reason=target?phases.get(target)?.reason:undefined;
        const facts=[...ids].flatMap(id=>{const item=byId.get(id),task=progressPhases.get(id);return item&&task?[{item,task}]:[];});
        const progress=record.kind==='decision'?recordProgress({...record,itemIds:roots.length?roots:record.itemIds},facts):undefined,completed=progress?.state==='completed';
        return {...record,...(progress?{progress}:{}),attentionTasks:!completed&&record.archivedAt===undefined&&record.deletedAt===undefined?attentionTasks:[],attention:completed?undefined:attention,attentionItemId:completed?undefined:target,attentionCode:!completed&&reason&&/^[A-Z][A-Z0-9_]{0,79}$/.test(reason)?reason:undefined};
    });
}

function pendingTask(item:KanbanItemSummary|undefined,task:KanbanTaskProjection|undefined):NonNullable<KanbanRecordSummary['attentionTasks']>{
    if(!task||!item||!['waiting-input','error','unknown'].includes(task.phase))return [];
    const ownIssue=item.blocked||item.issues?.some(issue=>!issue.resolvedBy)||['failed','blocked','clarification','unknown'].includes(item.analysis?.state??'');
    if(item.planning.execution==='children'&&!ownIssue)return [];
    return [{itemId:item.id,title:item.title,phase:task.phase as 'waiting-input'|'error'|'unknown',purpose:item.purpose==='planning'||item.planning.execution==='children'?'planning':'execution',...(task.sessionId?{sessionId:task.sessionId}:{})}];
}
