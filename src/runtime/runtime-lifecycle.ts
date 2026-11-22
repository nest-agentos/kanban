import {verifyRecordArchive} from './record-archive';
import type {KanbanBoard,KanbanCommand,KanbanService} from '../contracts';
import {KanbanError} from '../ports';
import {boardDeletionBlockers} from './board-deletion-inspection';
import type {KanbanAutomationJournal} from './automation-journal';
import type {KanbanRuntimeExtension} from './runtime-ports';
import {safeCode} from './diagnostics';
export async function verifyRuntimeLifecycle(service:KanbanService,journal:KanbanAutomationJournal,board:KanbanBoard,command:KanbanCommand) {
    if(command.type==='settle-record-recurrence'){
        const run=await journal.run<import('../contracts').KanbanRecordExecution>(board.id,command.roundId);
        if(!run||run.recordId!==command.recordId||!['completed','failed','cancelled'].includes(run.state))throw new KanbanError('RECURRENCE_SETTLEMENT_UNCONFIRMED');
    }
    if(command.type==='archive-record')await verifyRecordArchive(journal,board.id,command.recordId,id=>service.records(id,{kind:'decision',includeArchived:true,limit:200}));
    if(command.type==='delete-item') {
        const blocker=(await boardDeletionBlockers({service,journal},board.id)).find(row=>row.itemId===command.itemId);
        if(blocker)throw new KanbanError(blocker.code);
    }
    if(command.type==='cancel-record'||command.type==='delete-record'||command.type==='restart-record'||command.type==='revise-record') {
        const runs=await journal.runSummaries(board.id);
        if(runs?.some(run=>run.recordId===command.recordId&&!['completed','failed','cancelled'].includes(run.state)))throw new KanbanError('RECORD_EXECUTION_UNSETTLED');
        if(command.type==='delete-record'&&runs.some(run=>run.recordId===command.recordId)){
            const record=await service.record(board.id,command.recordId);
            if(!['cancelled','rejected','superseded'].includes(record.status))throw new KanbanError('RECORD_CANCEL_REQUIRED');
        }
    }
}
export function runtimeLifecycle(service:KanbanService & {quiesce():Promise<void>;dispose():Promise<void>},journal:KanbanAutomationJournal,extensions:KanbanRuntimeExtension[],beforeScan:()=>Promise<void>) {
    let stopping=false,pending:Promise<void>|undefined,closing:Promise<void>|undefined,disposing:Promise<void>|undefined;
    const scan=()=>stopping?Promise.resolve():pending??=(async()=>{await service.scan();await beforeScan();await all(extensions,'scan',journal);})().finally(()=>{pending=undefined;});
    const quiesce=()=>closing??=(async()=>{
        stopping=true;
        const results=await Promise.allSettled([all(extensions,'quiesce',journal),pending]);
        await service.quiesce();await journal.drain();
        if(results[1].status==='rejected')journal.diagnostic({operationId:'runtime:quiesce:scan',stage:'runtime.scan.drain',result:'failure',code:safeCode(results[1].reason,'KANBAN_SCAN_FAILED'),durationMs:0});
        failures([results[0]],'KANBAN_QUIESCE_FAILED');
    })();
    return {scan,quiesce,dispose:()=>disposing??=(async()=>{await quiesce();await all(extensions,'dispose',journal);await service.dispose();})()};
}
async function all(extensions:KanbanRuntimeExtension[],method:'scan'|'quiesce'|'dispose',journal:KanbanAutomationJournal) {
    const results=await Promise.allSettled(extensions.map(async(extension,index)=>{
        const started=Date.now();
        try{await extension[method]?.();}catch(error){journal.diagnostic({operationId:'runtime:'+method+':'+index,stage:'runtime.'+method,result:'failure',code:safeCode(error,'KANBAN_'+method.toUpperCase()+'_FAILED'),durationMs:Date.now()-started});throw error;}
    }));
    failures(results,'KANBAN_'+method.toUpperCase()+'_FAILED');
}
function failures(results:PromiseSettledResult<unknown>[],code:string) {
    const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
    if(errors.length)throw new AggregateError(errors,code);
}
