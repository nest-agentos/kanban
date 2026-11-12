import type {KanbanItemSummary,KanbanTaskProjection,KanbanRecordProgress} from './contracts';
import {kanbanTaskType} from './contracts/task-type';
import {managementTaskOwner} from './runtime/coordination-rules';
type Fact={item:KanbanItemSummary;task:KanbanTaskProjection};
const attention=['unknown','error','waiting-input','review','paused'];
const active=['analyzing','running','preparing','resuming'];
export function recordTaskHasOwnIssue(item:KanbanItemSummary):boolean {
    return !!(item.blocked||item.issues?.some(issue=>!issue.resolvedBy)||['failed','blocked','clarification','unknown'].includes(item.analysis?.state??''));
}
/** Recommend participation from task responsibility; never open or create a Session. */
export function recordParticipation(facts:Fact[],roots:Fact[]):NonNullable<KanbanRecordProgress['participation']> {
    const managers=roots.filter(({item})=>kanbanTaskType(item)==='coordination');
    const fallback=managers.length?managers:roots;
    if(roots.length&&roots.every(({task})=>task.phase==='completed'))return project('management',fallback);
    const live=facts.filter(({item})=>item.deletedAt===undefined&&item.archivedAt===undefined);
    const problems=live.filter(({item,task})=>attention.includes(task.phase)&&(item.planning.execution!=='children'||recordTaskHasOwnIssue(item)))
        .flatMap(fact=>responsible(fact,live));
    if(problems.length)return project('needs-action',problems);
    const executing=live.filter(({item,task})=>kanbanTaskType(item)==='execution'&&active.includes(task.phase)&&!!task.sessionId);
    return executing.length?project('running',executing):project('management',fallback);
}
function responsible(fact:Fact,facts:Fact[]):Fact[] {
    const issues=fact.item.issues?.filter(issue=>!issue.resolvedBy)??[];
    const parent=issues.some(issue=>issue.handler!=='self')||fact.item.analysis?.handler==='parent';
    if(!parent)return [fact];
    try {
        const owner=managementTaskOwner({items:facts.map(({item})=>item)},fact.item);
        return facts.filter(({item})=>item.id===owner?.id);
    } catch {return [];}
}
function project(reason:NonNullable<KanbanRecordProgress['participation']>['reason'],facts:Fact[]):NonNullable<KanbanRecordProgress['participation']> {
    const ordered=[...facts].sort((a,b)=>a.item.createdAt-b.item.createdAt||a.item.id.localeCompare(b.item.id));
    const unique=[...new Map(ordered.map(fact=>[kanbanTaskType(fact.item)==='execution'&&fact.task.sessionId?'session:'+fact.task.sessionId:'item:'+fact.item.id,fact])).values()];
    return {reason,targets:unique.map(({item,task})=>({itemId:item.id,title:item.title,phase:task.phase,
        purpose:kanbanTaskType(item)==='coordination'?'management':'execution'}))};
}
