import type {KanbanClient,KanbanRecordExecution,KanbanRecordSummary,KanbanItemSummary} from '../contracts';
import {recordProgress} from '../record-progress';

export type RecordRun=KanbanRecordExecution&{record?:{executionEpoch?:string}};
export function currentRecordRun(record:KanbanRecordSummary,runs:RecordRun[]):RecordRun|undefined {
    return runs.filter(run=>run.recordId===record.id&&run.record?.executionEpoch===record.executionEpoch&&(record.archivedAt!==undefined||run.archivedAt===undefined))
        .sort((a,b)=>b.createdAt-a.createdAt||b.updatedAt-a.updatedAt)[0];
}
function groupIds(run:RecordRun):string[] {
    return [...new Set(run.itemIds?.length?run.itemIds:run.rootItemId?[run.rootItemId]:[])];
}
function requiresGroups(record:KanbanRecordSummary,run:RecordRun,board:string):boolean {
    if(record.status!=='confirmed')return false;
    const ids=groupIds(run),projected=record.progress?.groupIds??record.itemIds;
    return !!ids.length&&(run.boardId!==board||record.progress?.reason==='TASK_GROUP_UNAVAILABLE'||ids.length!==projected.length||ids.some(id=>!projected.includes(id)));
}
/** Read current attempt summaries in batches; historical item links remain untouched. */
export async function currentGroupProgress(records:KanbanRecordSummary[],runs:Map<string,RecordRun>,board:string,service:Pick<KanbanClient,'query'>):Promise<Map<string,KanbanRecordSummary>> {
    const selected=records.filter(record=>{const run=runs.get(record.id);return run&&requiresGroups(record,run,board);});
    const targets=new Map<string,Set<string>>();
    for(const record of selected){const run=runs.get(record.id)!;const ids=targets.get(run.boardId)??new Set<string>();for(const id of groupIds(run))ids.add(id);targets.set(run.boardId,ids);}
    const facts=new Map<string,KanbanItemSummary[]>();
    for(const [target,ids] of targets){
        const list=[...ids],items:KanbanItemSummary[]=[];
        for(let offset=0;offset<list.length;offset+=200){const page=await service.query(target,{ids:list.slice(offset,offset+200),view:'all',includeDeleted:true,limit:200});items.push(...page.items);}
        facts.set(target,items);
    }
    return new Map(selected.map(record=>{
        const run=runs.get(record.id)!,ids=groupIds(run),items=(facts.get(run.boardId)??[]).filter(item=>ids.includes(item.id)&&item.deletedAt===undefined);
        const progress=recordProgress({...record,itemIds:ids},items.flatMap(item=>item.task?[{item,task:item.task}]:[]));
        const attention=progress.state==='failed'||progress.state==='checking'?'error' as const:progress.reason==='input-required'?'waiting-input' as const:undefined;
        return [record.id,{...record,progress,attention,attentionTasks:[],attentionItemId:attention?progress.itemId:undefined,attentionCode:attention?progress.reason:undefined}];
    }));
}
