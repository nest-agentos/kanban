import type {KanbanClient,KanbanProjectRecord,KanbanRecordExecution,KanbanRecurrence} from '../contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import {recurrenceAdmission,recurrenceIntentId} from './recurrence-admission';
import {nextRecurrence} from './recurrence-time';
import {journalCommand} from './journal-command';
import {safeCode} from './diagnostics';

type Log=(event:{operationId:string;boardId:string;stage:string;result:'success'|'failure';code?:string;durationMs:number})=>void;
type Runner={runRecurring:import('./record-execution').RecordRecurringRunner};
interface Cursor {revision:number;nextAt:number}
const cursorKey=(board:string,id:string)=>'recurrence-cursor:'+JSON.stringify([board,id]);
export async function recurrenceNextTime(journal:KanbanAutomationJournal,board:string,record:KanbanProjectRecord):Promise<number|undefined> {
    if(record.recurrence?.state!=='active'||record.recurrence.trigger==='after-settlement'&&record.recurrenceFence?.pending.length)return;
    const cursor=await journal.get<Cursor>(cursorKey(board,record.id));
    return cursor&&cursor.revision===record.recurrenceRevision?cursor.nextAt:undefined;
}

/** Runtime scans share the durable board fence and reconcile existing reservations first. */
export function createRecurrenceScheduler(service:KanbanClient,journal:KanbanAutomationJournal,records:Runner,log:Log,now=Date.now) {
    let initial=true,stopped=false;
    const admission=recurrenceAdmission({journal,log,now,submit:async intent=>{
        const run=await records.runRecurring(intent);return {state:'admitted',runId:run.id};
    },inspect:async intent=>{
        const run=await journal.run<KanbanRecordExecution>(intent.boardId,intent.id);
        if(!run)return {state:'unknown',code:'RECURRENCE_RECEIPT_UNKNOWN'};
        return {state:['completed','failed','cancelled'].includes(run.state)?'settled':'admitted',runId:run.id,settledAt:run.updatedAt};
    }});
    async function scan() {
        if(stopped)return;
        for(const board of await service.catalog()){
            let cursor:string|undefined;
            do{
                const page=await service.records(board.id,{kind:'decision',limit:200,cursor});
                for(const summary of page.items)if(summary.recurrence||summary.recurrencePending)await processRecord(board.id,summary.id);
                cursor=page.nextCursor;
            }while(cursor&&!stopped);
        }
        initial=false;
    }
    async function processRecord(board:string,id:string) {
        const started=now(),operationId='recurrence-scan:'+id;
        try {
            let record=await service.record(board,id);
            if(!record.recurrence&&!record.recurrenceFence?.pending.length)return;
            await reconcilePending(board,record);
            record=await service.record(board,id);
            if(record.recurrence?.state==='active'&&record.status==='confirmed')await schedule(board,record);
            log({operationId,boardId:board,stage:'recurrence.scan',result:'success',durationMs:now()-started});
        }catch(error){log({operationId,boardId:board,stage:'recurrence.scan',result:'failure',code:safeCode(error,'RECURRENCE_SCAN_FAILED'),durationMs:now()-started});}
    }
    async function reconcilePending(board:string,record:KanbanProjectRecord) {
        for(const reservation of record.recurrenceFence?.pending??[]){
            const intent=await admission.adopt(board,reservation);
            const result=await admission.reconcile(intent);
            if(result.phase==='settled')await settle(board,record,result.id,result.settledAt??now());
        }
    }
    async function settle(board:string,record:KanbanProjectRecord,id:string,settledAt:number) {
        if(record.recurrence?.trigger==='after-settlement'&&record.recurrenceRevision){
            const nextAt=afterSettlement(record.recurrence,settledAt);
            await journal.update<Cursor>(cursorKey(board,record.id),old=>old&&old.revision===record.recurrenceRevision?{revision:old.revision,nextAt}:old??{revision:record.recurrenceRevision!,nextAt});
        }
        await journalCommand(journal,service,board,'recurrence-settle:'+id,{type:'settle-record-recurrence',recordId:record.id,roundId:id});
    }
    async function schedule(board:string,record:KanbanProjectRecord) {
        const config=record.recurrence!,revision=record.recurrenceRevision!,current=now(),key=cursorKey(board,record.id);
        if(config.trigger==='after-settlement'&&record.recurrenceFence?.pending.length)return;
        const state=await journal.update<Cursor>(key,old=>{
            if(!old||old.revision!==revision)return {revision,nextAt:nextRecurrence(config,current)};
            if(initial)return {revision,nextAt:config.trigger==='fixed'?nextRecurrence(config,current):Math.max(old.nextAt,nextRecurrence(config,current))};
            return old;
        });
        if(state.nextAt>current)return;
        if(nextRecurrence(config,state.nextAt)<=current){
            const nextAt=config.trigger==='after-settlement'?afterSettlement(config,current):nextRecurrence(config,current);
            await journal.update<Cursor>(key,old=>old?.revision===revision&&old.nextAt===state.nextAt?{revision,nextAt}:old!);return;
        }
        const id=recurrenceIntentId(board,record.id,revision,state.nextAt);
        await journalCommand(journal,service,board,'recurrence-fence:'+id,{type:'reserve-record-recurrence',recordId:record.id,configRevision:revision,scheduledAt:state.nextAt});
        await journal.update<Cursor>(key,old=>old?.revision===revision&&old.nextAt===state.nextAt?{revision,nextAt:nextRecurrence(config,current)}:old!);
        await reconcilePending(board,await service.record(board,record.id));
    }
    return {scan,quiesce:async()=>{stopped=true;}};
}
function afterSettlement(config:KanbanRecurrence,at:number):number {
    return config.cadence.kind==='interval'?at+config.cadence.milliseconds:nextRecurrence(config,at);
}
