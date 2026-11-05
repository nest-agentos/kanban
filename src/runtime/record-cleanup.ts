import {sha256HexSync} from '../utils';
import type {KanbanClient,KanbanRecordExecution,KanbanItem} from '../contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import {journalCommand} from './journal-command';
import {requireValue} from '../rules';

/** Only generated run roots and their descendants belong to decision cleanup. */
export async function cleanupRecordTasks(service:KanbanClient,journal:KanbanAutomationJournal,runs:KanbanRecordExecution[],action:'archive'|'delete',operationId:string,archiveSession?:(id:string,operation:string)=>Promise<void>,planningSession?:KanbanClient['planningSession']):Promise<void> {
    for(const run of runs){
        const roots=[...new Set([run.rootItemId,...run.itemIds??[]].filter((id):id is string=>!!id))];
        const items=new Map<string,{item:KanbanItem;archived:boolean}>();
        for(const id of roots)await collect(service,run.boardId,id,items);
        if(archiveSession)for(const id of items.keys())await archiveItemSessions(service,planningSession,run.boardId,id,operationId,archiveSession);
        for(const {item,archived} of [...items.values()].reverse()){
            requireValue(['completed','cancelled'].includes(item.status),'RECORD_EXECUTION_UNSETTLED');
            if(item.deletedAt!==undefined||action==='archive'&&archived)continue;
            if(action==='delete'&&archived)await journalCommand(journal,service,run.boardId,'record-cleanup-restore:'+operationId+':'+item.id,{type:'restore-item',itemId:item.id});
            await journalCommand(journal,service,run.boardId,'record-cleanup:'+JSON.stringify([operationId,action,item.id]),action==='archive'
                ?{type:'archive-items',itemIds:[item.id],reason:'decision-'+operationId}:{type:'delete-item',itemId:item.id});
        }
    }
}
async function collect(service:KanbanClient,board:string,id:string,items:Map<string,{item:KanbanItem;archived:boolean}>):Promise<void> {
    if(items.has(id))return;
    const detail=await service.item(board,id);items.set(id,{item:detail.item,archived:!!detail.archive});
    for(const view of ['all','archive'] as const){
        let cursor:string|undefined;
        do {const page=await service.query(board,{view,parentId:id,limit:200,cursor});
            for(const child of page.items)await collect(service,board,child.id,items);
            cursor=page.nextCursor;
        }while(cursor);
    }
}

async function archiveItemSessions(service:KanbanClient,planning:KanbanClient['planningSession'],board:string,id:string,operation:string,archive:(id:string,operation:string)=>Promise<void>):Promise<void> {
    const detail=await service.executionSession?.(board,id,{includeRelated:true}),planned=await planning?.(board,id);
    const ids=new Set([planned?.sessionId,detail?.current?.sessionId,...detail?.sessions?.map(row=>row.sessionId)??[],...detail?.history.map(row=>row.sessionId)??[]].filter((value):value is string=>!!value));
    for(const session of ids)await archive(session,sha256HexSync(JSON.stringify([operation,session])));
}
