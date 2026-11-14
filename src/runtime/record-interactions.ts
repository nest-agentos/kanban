import {forEachRecordScope} from './record-read-scopes';
import type {KanbanClient,KanbanRecordPage,KanbanRecordSummary,KanbanSessionItemSummary} from '../contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import {randomUUID} from '../utils';
import {safeCode} from './diagnostics';

function targets(record:KanbanRecordSummary):string[] {
    if(record.status!=='confirmed'||record.archivedAt!==undefined||!['running','waiting','needs-action'].includes(record.progress?.state??''))return [];
    return record.progress?.participation?.targets.map(target=>target.itemId)??(record.progress?.itemId?[record.progress.itemId]:[]);
}
/** Read current bound Session metadata in batches; waiting cannot settle or restart a task. */
export async function withRecordInteractions(page:KanbanRecordPage,board:string,service:Pick<KanbanClient,'queryActivity'>|undefined,journal:KanbanAutomationJournal):Promise<KanbanRecordPage> {
    if(!service?.queryActivity)return page;
    const queryActivity=service.queryActivity.bind(service);
    const scopes=new Map<string,Set<string>>(),rows=new Map<string,KanbanSessionItemSummary[]>();
    for(const record of page.items){const id=record.progress?.boardId??board,ids=scopes.get(id)??new Set<string>();for(const item of targets(record))ids.add(item);if(ids.size)scopes.set(id,ids);}
    await forEachRecordScope(scopes,async([id,ids])=>{
        const started=Date.now(),operationId=randomUUID(),items:KanbanSessionItemSummary[]=[];
        try {
            const list=[...ids];
            for(let offset=0;offset<list.length;offset+=200)items.push(...(await queryActivity(id,{ids:list.slice(offset,offset+200),view:'all',limit:200})).items);
            rows.set(id,items);
            journal.diagnostic({operationId,boardId:id,stage:'record.interactions.read',result:'success',count:items.length,durationMs:Date.now()-started});
        }catch(error){journal.diagnostic({operationId,boardId:id,stage:'record.interactions.read',result:'failure',code:safeCode(error,'RECORD_INTERACTIONS_READ_FAILED'),durationMs:Date.now()-started});}
    });
    return {...page,items:page.items.map(record=>project(record,rows.get(record.progress?.boardId??board)??[]))};
}
function project(record:KanbanRecordSummary,rows:KanbanSessionItemSummary[]):KanbanRecordSummary {
    const ids=new Set(targets(record));
    const participation=record.progress?.participation;
    if(participation)record={...record,progress:{...record.progress!,participation:{...participation,targets:participation.targets.map(target=>{
        const row=rows.find(row=>row.id===target.itemId),execution=row?.execution;
        return execution&&!execution.stale&&row?.task?.sessionId===execution.sessionId&&execution.resourceId?{...target,resourceId:execution.resourceId}:target;
    })}}};
    const progress=record.progress;
    const waiting=rows.filter(row=>ids.has(row.id)&&row.execution&&!row.execution.stale&&['waiting-approval','waiting-input'].includes(row.execution.state)
        &&row.task?.sessionId===row.execution.sessionId&&['running','waiting-input','analyzing'].includes(row.task.phase));
    if(!progress||!waiting.length)return record;
    waiting.sort((a,b)=>Number(b.execution!.state==='waiting-approval')-Number(a.execution!.state==='waiting-approval'));
    const interactions=waiting.flatMap(row=>row.execution!.resourceId?[{kind:row.execution!.state==='waiting-approval'?'approval' as const:'input' as const,itemId:row.id,sessionId:row.execution!.sessionId,resourceId:row.execution!.resourceId,title:row.title,requestIds:row.execution!.interactionIds}]:[]);
    const first=waiting[0],reason=first.execution!.state==='waiting-approval'?'authorization-required':'input-required';
    return {...record,attention:'waiting-input',attentionCode:reason,attentionItemId:first.id,progress:{...progress,state:'needs-action',phase:'waiting-input',reason,itemId:first.id,sessionId:first.execution!.sessionId,interactions,
        participation:{reason:'needs-action',targets:waiting.map(row=>({itemId:row.id,title:row.title,phase:'waiting-input',purpose:'execution',resourceId:row.execution?.resourceId}))}}};
}
