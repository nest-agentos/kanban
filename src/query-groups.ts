import {kanbanTaskType,kanbanAttentionRank} from './contracts';
import type {KanbanItemQuery,KanbanItemSummary,KanbanTaskGroup} from './contracts';

/** Resolve ownership before pagination so a child cannot orphan its manager. */
export function managementRoots(matches:KanbanItemSummary[],all:KanbanItemSummary[]):KanbanItemSummary[] {
    const byId=new Map(all.filter(row=>row.deletedAt===undefined&&row.archivedAt===undefined).map(row=>[row.id,row]));
    return [...new Map(matches.map(row=>{const root=managementOwner(row,byId);return [root.id,root] as const;})).values()];
}
function managementOwner(item:KanbanItemSummary,byId:Map<string,KanbanItemSummary>):KanbanItemSummary {
    let current=item,owner=item;const seen=new Set([item.id]);
    while(current.planning.parentId){
        const parent=byId.get(current.planning.parentId);if(!parent||seen.has(parent.id))break;
        seen.add(parent.id);if(kanbanTaskType(parent)==='coordination')owner=parent;current=parent;
    }
    return owner;
}
export function managementGroups(roots:KanbanItemSummary[],all:KanbanItemSummary[],preferred?:Set<string>):KanbanTaskGroup[] {
    const live=all.filter(row=>row.deletedAt===undefined&&row.archivedAt===undefined);
    const byId=new Map(live.map(row=>[row.id,row])),children=new Map<string,KanbanItemSummary[]>();
    for(const row of live){
        if(['completed','cancelled'].includes(row.status))continue;
        const owner=managementOwner(row,byId);if(owner.id===row.id)continue;
        const rows=children.get(owner.id)??[];rows.push(row);children.set(owner.id,rows);
    }
    return roots.filter(row=>kanbanTaskType(row)==='coordination').map(row=>{
        const items=(children.get(row.id)??[]).sort((a,b)=>Number(preferred?.has(b.id)??false)-Number(preferred?.has(a.id)??false)||kanbanAttentionRank(a)-kanbanAttentionRank(b)||a.planning.priority-b.planning.priority||a.createdAt-b.createdAt||a.id.localeCompare(b.id));
        return {parentId:row.id,total:items.length,items:items.slice(0,6)};
    });
}

export function managementGrouping(query:KanbanItemQuery):boolean {
    return query.groupBy==='management'&&!['archive','closed'].includes(query.view??'all');
}
