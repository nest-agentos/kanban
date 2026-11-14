import {defaultReferences} from './ports';
import {compareKanbanItems} from '../queries';
import type {KanbanActivityHandle} from '../activity';
import type {KanbanItemQuery,KanbanItemSummary,KanbanItemPage} from '../contracts';
import {createKanbanSessionActivity} from '../session-activity';
import type {KanbanRuntimeOptions} from './runtime-ports';
import {KanbanError} from '../ports';
import {randomUUID} from '../utils';
import {safeCode} from './diagnostics';
type Facts={revision?:number;items:Map<string,KanbanItemSummary>;all:Set<string>;visible:Set<string>};
const createFacts=():Facts=>({items:new Map(),all:new Set(),visible:new Set()});
function reusable(query:KanbanItemQuery):boolean {
    return Array.isArray(query.ids)&&query.ids.length>0&&query.ids.length<=200&&query.limit===200&&query.view==='all'&&!query.cursor&&Object.keys(query).every(key=>['ids','view','includeDeleted','limit'].includes(key));
}
/** The query plan owns these facts only until this record-page assembly finishes. */
export function recordReadSource(service:KanbanActivityHandle,options:KanbanRuntimeOptions):Pick<KanbanActivityHandle,'query'|'queryActivity'> {
    const boards=new Map<string,Facts>(),operationId=randomUUID();
    const query:KanbanActivityHandle['query']=async(board,input={})=>{
        if(!reusable(input))return service.query(board,input);
        const facts=boards.get(board)??createFacts();boards.set(board,facts);
        return readItems(service,board,input,facts,operationId,options.log);
    };
    const activity=createKanbanSessionActivity({...service,query},options.executionSessions,event=>options.log?.(event),options.referenceSystem??defaultReferences.execution);
    return {query,queryActivity:activity.queryActivity};
}
async function readItems(service:KanbanActivityHandle,board:string,query:KanbanItemQuery,facts:Facts,operationId:string,log:KanbanRuntimeOptions['log']):Promise<KanbanItemPage> {
    const started=Date.now(),ids=[...new Set(query.ids!)],missing=ids.filter(id=>!facts.all.has(id)&&(query.includeDeleted||!facts.visible.has(id)));
    try {
        if(missing.length) {
            const page=await service.query(board,{...query,ids:missing,limit:200});
            if(facts.revision!==undefined&&facts.revision!==page.revision)throw new KanbanError('CURSOR_STALE');
            if(page.nextCursor)throw new KanbanError('RECORD_ITEMS_PAGE_INCOMPLETE');
            facts.revision=page.revision;
            for(const row of page.items)facts.items.set(row.id,row);
            for(const id of missing)(query.includeDeleted?facts.all:facts.visible).add(id);
        }
        const items=ids.flatMap(id=>{const row=facts.items.get(id);return row&&(query.includeDeleted||row.deletedAt===undefined)?[row]:[];}).sort(compareKanbanItems);
        log?.({operationId,boardId:board,stage:'record.items.storage',result:'success',count:missing.length,readCount:missing.length?1:0,durationMs:Date.now()-started});
        return {revision:facts.revision??0,total:items.length,items};
    }catch(error){log?.({operationId,boardId:board,stage:'record.items.storage',result:'failure',code:safeCode(error,'RECORD_ITEMS_READ_FAILED'),durationMs:Date.now()-started});throw error;}
}
