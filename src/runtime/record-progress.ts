import type {KanbanRecordPage,KanbanRecordSummary,KanbanRecordProgress} from '../contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import {randomUUID} from '../utils';
import {safeCode} from './diagnostics';
import {currentRecordRun,currentGroupProgress,type RecordRun} from './record-progress-groups';

type Run=RecordRun;
/** One bounded journal read covers every decision on the page, including cross-board runs. */
export async function withRecordProgress(page:KanbanRecordPage,board:string,journal:KanbanAutomationJournal,service?:Pick<import('../contracts').KanbanClient,'query'>):Promise<KanbanRecordPage> {
    if(!page.items.some(row=>row.kind==='decision'))return page;
    const started=Date.now(),operationId=randomUUID();
    let runs:Run[];
    try {runs=await journal.get<Run[]>('record-runs:'+board)??[];}
    catch(error){journal.diagnostic({operationId,boardId:board,stage:'record.progress.read',result:'failure',code:safeCode(error,'RECORD_PROGRESS_READ_FAILED'),durationMs:Date.now()-started});throw error;}
    journal.diagnostic({operationId,boardId:board,stage:'record.progress.read',result:'success',count:page.items.length,durationMs:Date.now()-started});
    const currentRuns=new Map(page.items.flatMap(record=>{const run=currentRecordRun(record,runs);return run?[[record.id,run] as const]:[];}));
    let projected=new Map<string,KanbanRecordSummary>();
    if(service)try {
        projected=await currentGroupProgress(page.items,currentRuns,board,service);
        if(projected.size)journal.diagnostic({operationId,boardId:board,stage:'record.progress.groups',result:'success',count:projected.size,durationMs:Date.now()-started});
    }catch(error){journal.diagnostic({operationId,boardId:board,stage:'record.progress.groups',result:'failure',code:safeCode(error,'TASK_GROUP_READ_FAILED'),durationMs:Date.now()-started});throw error;}
    return {...page,items:page.items.map(record=>{
        if(record.kind!=='decision')return record;
        record=projected.get(record.id)??record;
        const current=currentRuns.get(record.id);
        return current?{...record,progress:executionProgress(record,current)}:record;
    })};
}
function executionProgress(record:KanbanRecordSummary,run:Run):KanbanRecordProgress {
    const progress=record.progress??{state:'waiting' as const,lastActivityAt:record.updatedAt};
    const groupIds=progress.groupIds??[...new Set([run.rootItemId,...run.itemIds??[]].filter((id):id is string=>!!id))];
    const base={...progress,groupIds,...(run.rootItemId||run.itemIds?.[0]?{boardId:run.boardId,itemId:progress.itemId??run.rootItemId??run.itemIds?.[0]}:{}),lastActivityAt:Math.max(progress.lastActivityAt,run.updatedAt)};
    if(record.status!=='confirmed'&&!(record.archivedAt!==undefined&&['completed','failed'].includes(run.state)))return base;
    const phase=run.stage??progress.phase,completion=completionResult(progress.completion,run.completion);
    if(progress.groupIds?.length&&record.status==='confirmed')return {...base,completion:progress.state==='completed'?completion:progress.completion};
    if(progress.state==='completed')return {...base,phase,reason:undefined,completion:completion};
    if(run.state==='preparing')return {...base,state:'waiting',phase:'preparing',reason:run.code};
    if(run.state==='completed')return {...base,state:'completed',phase,reason:undefined,completion:completion};
    if(run.state==='unknown')return {...base,state:'checking',phase,reason:run.code};
    if(run.state==='blocked'&&progress.state==='checking')return {...base,state:'checking',phase,reason:progress.reason??run.code};
    if(run.state==='failed'||run.state==='blocked')return {...base,state:run.code==='DECISION_INPUT_REQUIRED'?'needs-action':'failed',phase,reason:run.code??progress.reason};
    if(run.state==='review')return {...base,state:'needs-action',phase,reason:'acceptance-required'};
    if(run.state==='cancelling'||run.state==='cancelled')return {...base,state:run.state,phase,reason:run.code};
    if(['paused','pausing','resuming'].includes(run.state))return {...base,state:run.state==='paused'?'waiting':'running',phase:run.state as 'paused'|'pausing'|'resuming',reason:run.code};
    return {...base,...(!record.itemIds.length?{state:'running' as const,phase}:{}),reason:progress.reason==='awaiting-execution'?undefined:progress.reason};
}

function completionResult(current:KanbanRecordProgress['completion'],saved:KanbanRecordProgress['completion']):KanbanRecordProgress['completion'] {
    if(current==='mixed'||saved==='mixed')return 'mixed';
    if(current==='waived'||saved==='waived')return 'waived';
    return current??saved;
}
