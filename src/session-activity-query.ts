import {managementRoots,managementGroups,managementGrouping} from './query-groups';
import {kanbanAttentionRank} from './contracts';
import {sha256HexSync} from './utils';
import type {KanbanService, KanbanSessionActivityQuery, KanbanSessionItemPage, KanbanSessionItemSummary} from './contracts';
import {KanbanError} from './ports';
/** Filter before pagination; Session activity changes invalidate the filtered keyset. */
export async function querySessionItems(core: KanbanService, boardId: string, input: KanbanSessionActivityQuery,
    project: (rows: KanbanSessionItemSummary[])=>Promise<KanbanSessionItemSummary[]>): Promise<KanbanSessionItemPage> {
    const {execution='all',...query}=input;
    if(!['all','running','recent','active'].includes(execution)) throw new KanbanError('INVALID_EXECUTION_FILTER');
    if(query.groupBy!==undefined&&query.groupBy!=='management'||query.groupBy&&query.parentId)throw new KanbanError('INVALID_GROUPING');
    return execution==='all'?projectPage(await core.query(boardId,query),project):filteredSessionItems(core,boardId,query,execution,project);
}
async function projectPage(page:KanbanSessionItemPage,project:(rows:KanbanSessionItemSummary[])=>Promise<KanbanSessionItemSummary[]>):Promise<KanbanSessionItemPage> {
    const entries=[...page.items,...page.attentionItems??[],...page.groups?.flatMap(group=>group.items)??[]];
    const rows=await project([...new Map(entries.map(item=>[item.id,item])).values()]),byId=new Map(rows.map(item=>[item.id,item]));
    return {...page,items:page.items.map(item=>byId.get(item.id)!),
        ...(page.groups?{groups:page.groups.map(group=>({...group,items:group.items.map(item=>byId.get(item.id)!)}))}:{}),
        ...(page.attentionItems?{attentionItems:page.attentionItems.map(item=>byId.get(item.id)!)}:{})};
}
async function filteredSessionItems(core:KanbanService,boardId:string,query:KanbanSessionActivityQuery,execution:string,
    project:(rows:KanbanSessionItemSummary[])=>Promise<KanbanSessionItemSummary[]>):Promise<KanbanSessionItemPage> {
    const {cursor,limit=50,...filters}=query;
    if(!Number.isSafeInteger(limit)||limit<1||limit>200) throw new KanbanError('INVALID_PAGE_SIZE');
    const flat={...filters,groupBy:undefined};
    const page=await collectItems(core,boardId,flat),revision=page.revision;
    const rows=await project(page.items),matching=rows.filter(row=>matchesExecution(row,execution));
    const owners=managementGrouping(filters)
        ?await collectItems(core,boardId,{view:'all',excludeArchived:true}):page;
    if(owners.revision!==revision||(await core.query(boardId,{...flat,limit:1})).revision!==revision) throw new KanbanError('CURSOR_STALE');
    const projected=new Map(rows.map(row=>[row.id,row]));
    const all=owners.items.map(row=>projected.get(row.id)??row);
    const roots=managementGrouping(filters)?managementRoots(matching,all).sort((a,b)=>kanbanAttentionRank(a)-kanbanAttentionRank(b)||a.planning.priority-b.planning.priority||a.id.localeCompare(b.id)):matching;
    const scope=sha256HexSync(JSON.stringify({filters,execution,limit})), signature=sha256HexSync(JSON.stringify(matching.map(row=>row.id)));
    const start=activityPageStart(cursor,{scope,revision,signature},roots);
    const items=roots.slice(start,start+limit);
    return {revision,total:roots.length,items,...(managementGrouping(filters)?{groups:managementGroups(items,all,new Set(matching.map(row=>row.id)))}:{}),...(start+items.length<roots.length?{nextCursor:JSON.stringify({scope,revision,signature,after:items.at(-1)!.id})}: {})};
}
function matchesExecution(row: KanbanSessionItemSummary, filter: string): boolean {
    const session=row.execution;if(!session||session.stale) return false;
    return filter==='running'?session.state==='running':filter==='recent'?session.recent:session.state==='running'||session.recent;
}

async function collectItems(core:KanbanService,boardId:string,query:KanbanSessionActivityQuery):Promise<KanbanSessionItemPage> {
    let page=await core.query(boardId,{...query,limit:200});const revision=page.revision,items=[...page.items];
    if(page.total>10000)throw new KanbanError('ACTIVITY_QUERY_LIMIT');
    while(page.nextCursor){
        page=await core.query(boardId,{...query,limit:200,cursor:page.nextCursor});
        if(page.revision!==revision)throw new KanbanError('CURSOR_STALE');items.push(...page.items);
    }
    return {revision,total:items.length,items};
}

function activityPageStart(cursor:string|undefined,key:{scope:string;revision:number;signature:string},roots:KanbanSessionItemSummary[]):number {
    if(!cursor)return 0;
    let saved;try {saved=JSON.parse(cursor);} catch {throw new KanbanError('INVALID_CURSOR');}
    if(!saved||saved.scope!==key.scope)throw new KanbanError('CURSOR_SCOPE_MISMATCH');
    if(saved.revision!==key.revision||saved.signature!==key.signature)throw new KanbanError('CURSOR_STALE');
    const start=roots.findIndex(row=>row.id===saved.after)+1;if(start<1)throw new KanbanError('INVALID_CURSOR');return start;
}
