import {sha256HexSync} from './utils';
import type {KanbanService, KanbanSessionActivityQuery, KanbanSessionItemPage, KanbanSessionItemSummary} from './contracts';
import {KanbanError} from './ports';
/** Filter before pagination; Session activity changes invalidate the filtered keyset. */
export async function querySessionItems(core: KanbanService, boardId: string, input: KanbanSessionActivityQuery,
    project: (rows: KanbanSessionItemSummary[])=>Promise<KanbanSessionItemSummary[]>): Promise<KanbanSessionItemPage> {
    const {execution='all',...query}=input;
    if(!['all','running','recent','active'].includes(execution)) throw new KanbanError('INVALID_EXECUTION_FILTER');
    if(execution==='all') {const page=await core.query(boardId,query);return {...page,items:await project(page.items)};}
    const {cursor,limit=50,...filters}=query;
    if(!Number.isSafeInteger(limit)||limit<1||limit>200) throw new KanbanError('INVALID_PAGE_SIZE');
    let page=await core.query(boardId,{...filters,limit:200}), rows=[...page.items];const revision=page.revision;
    while(page.nextCursor) {
        if(rows.length>=10000) throw new KanbanError('ACTIVITY_QUERY_LIMIT');
        page=await core.query(boardId,{...filters,limit:200,cursor:page.nextCursor});
        if(page.revision!==revision) throw new KanbanError('CURSOR_STALE');rows.push(...page.items);
    }
    const matching=(await project(rows)).filter(row=>matchesExecution(row,execution));
    if((await core.query(boardId,{...filters,limit:1})).revision!==revision) throw new KanbanError('CURSOR_STALE');
    const scope=sha256HexSync(JSON.stringify({filters,execution,limit})), signature=sha256HexSync(JSON.stringify(matching.map(row=>row.id)));
    let start=0;
    if(cursor) {
        let saved;try {saved=JSON.parse(cursor);} catch {throw new KanbanError('INVALID_CURSOR');}
        if(saved.scope!==scope) throw new KanbanError('CURSOR_SCOPE_MISMATCH');
        if(saved.revision!==revision||saved.signature!==signature) throw new KanbanError('CURSOR_STALE');
        start=matching.findIndex(row=>row.id===saved.after)+1;if(start<1) throw new KanbanError('INVALID_CURSOR');
    }
    const items=matching.slice(start,start+limit);
    return {revision,total:matching.length,items,...(start+items.length<matching.length?{nextCursor:JSON.stringify({scope,revision,signature,after:items.at(-1)!.id})}: {})};
}
function matchesExecution(row: KanbanSessionItemSummary, filter: string): boolean {
    const session=row.execution;if(!session||session.stale) return false;
    return filter==='running'?session.state==='running':filter==='recent'?session.recent:session.state==='running'||session.recent;
}
