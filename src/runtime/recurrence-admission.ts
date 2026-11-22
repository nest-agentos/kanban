import type {KanbanProjectRecord} from '../contracts';
import {sha256HexSync} from '../utils';
import {requireValue} from '../rules';
import {safeCode} from './diagnostics';
import type {KanbanAutomationJournal} from './automation-journal';

type Phase='prepared'|'submitting'|'unknown'|'admitted'|'settled'|'skipped';
export interface RecurrenceIntent {
    id:string;boardId:string;recordId:string;configRevision:number;scheduledAt:number;
    record:KanbanProjectRecord;phase:Phase;runId?:string;settledAt?:number;code?:string;updatedAt:number;
    layout?:'row';
}
type Receipt={state:'admitted'|'settled';runId:string;settledAt?:number}|{state:'absent'}|{state:'unknown';code?:string};
interface Ports {
    journal:Pick<KanbanAutomationJournal,'get'|'update'>;
    /** `absent` is a formal not-started receipt, never an unobserved or pending operation. */
    inspect(intent:RecurrenceIntent):Promise<Receipt>;
    submit(intent:RecurrenceIntent):Promise<Extract<Receipt,{runId:string}>>;
    log(event:{operationId:string;boardId:string;stage:string;result:'success'|'failure';code?:string;durationMs:number}):void;
    now?():number;
}
const key=(board:string,record:string)=>'recurrence-admission:'+JSON.stringify([board,record]);
export const recurrenceIntentKey=(id:string)=>'recurrence-intent:'+id;
const active=(intent:RecurrenceIntent)=>!['settled','skipped'].includes(intent.phase);
export function recurrenceIntentId(board:string,record:string,revision:number,scheduledAt:number):string {
    return 'round-'+sha256HexSync(JSON.stringify([board,record,revision,scheduledAt]));
}

/** Persist the immutable intent before starting the external admission operation. */
export function recurrenceAdmission(ports:Ports) {
    const now=ports.now??Date.now,pending=new Map<string,Promise<RecurrenceIntent>>();
    async function reserve(boardId:string,record:KanbanProjectRecord,configRevision:number,scheduledAt:number):Promise<RecurrenceIntent> {
        const started=now(),id=recurrenceIntentId(boardId,record.id,configRevision,scheduledAt);
        try {
        requireValue(record.kind==='decision'&&record.status==='confirmed'&&record.deletedAt===undefined&&record.archivedAt===undefined,'DECISION_NOT_CONFIRMED');
        requireValue(record.recurrence?.state==='active','RECURRENCE_NOT_ACTIVE');
        requireValue(Number.isSafeInteger(configRevision)&&configRevision>0&&configRevision===(record.recurrenceRevision??record.revision)&&Number.isSafeInteger(scheduledAt)&&scheduledAt>=0,'RECURRENCE_IDENTITY_INVALID');
        const saved=await ports.journal.update<RecurrenceIntent[]>(key(boardId,record.id),old=>{
            const rows=old??[],existing=rows.find(row=>row.id===id);if(existing)return rows;
            const phase=rows.filter(active).length>=record.recurrence!.maxConcurrency?'skipped':'prepared';
            return [...rows,{id,boardId,recordId:record.id,configRevision,scheduledAt,record:structuredClone(record),phase,updatedAt:now()}];
        });
        const intent=saved.find(row=>row.id===id)!;
        ports.log({operationId:id,boardId,stage:'recurrence.reserve',result:'success',...(intent.phase==='skipped'?{code:'RECURRENCE_CONCURRENCY_LIMIT'}:{}),durationMs:now()-started});return intent;
        }catch(error){ports.log({operationId:id,boardId,stage:'recurrence.reserve',result:'failure',code:safeCode(error,'RECURRENCE_RESERVATION_FAILED'),durationMs:now()-started});throw error;}
    }
    async function read(boardId:string,recordId:string):Promise<RecurrenceIntent[]> {return await ports.journal.get<RecurrenceIntent[]>(key(boardId,recordId))??[];}
    async function adopt(boardId:string,reservation:import('../contracts').KanbanRecurrenceReservation):Promise<RecurrenceIntent> {
        const {id,record,configRevision,scheduledAt}=reservation;
        requireValue(id===recurrenceIntentId(boardId,record.id,configRevision,scheduledAt),'RECURRENCE_IDENTITY_INVALID');
        return ports.journal.update<RecurrenceIntent>(recurrenceIntentKey(id),old=>{
            if(old){requireValue(old.boardId===boardId&&old.recordId===record.id&&old.configRevision===configRevision&&old.scheduledAt===scheduledAt&&JSON.stringify(old.record)===JSON.stringify(record),'RECURRENCE_INTENT_CONFLICT');return old;}
            return {id,boardId,recordId:record.id,configRevision,scheduledAt,record:structuredClone(record),phase:'prepared',layout:'row',updatedAt:now()};
        });
    }
    async function update(intent:RecurrenceIntent,change:(row:RecurrenceIntent)=>RecurrenceIntent):Promise<RecurrenceIntent> {
        if(intent.layout==='row')return ports.journal.update<RecurrenceIntent>(recurrenceIntentKey(intent.id),old=>{requireValue(old,'RECURRENCE_INTENT_MISSING');return change(old!);});
        const saved=await ports.journal.update<RecurrenceIntent[]>(key(intent.boardId,intent.recordId),old=>{
            requireValue(old&&old.some(row=>row.id===intent.id),'RECURRENCE_INTENT_MISSING');return old!.map(row=>row.id===intent.id?change(row):row);
        });return saved.find(row=>row.id===intent.id)!;
    }
    async function reconcile(intent:RecurrenceIntent):Promise<RecurrenceIntent> {
        if(['skipped','settled'].includes(intent.phase))return intent;
        let operation=pending.get(intent.id);
        if(!operation){operation=advance(intent).finally(()=>pending.delete(intent.id));pending.set(intent.id,operation);}
        return operation;
    }
    async function advance(input:RecurrenceIntent):Promise<RecurrenceIntent> {
        const started=now();let intent=input.layout==='row'?await ports.journal.get<RecurrenceIntent>(recurrenceIntentKey(input.id)):(await read(input.boardId,input.recordId)).find(row=>row.id===input.id);
        requireValue(intent,'RECURRENCE_INTENT_MISSING');if(!active(intent))return intent;
        try {
            if(intent.phase!=='prepared'){
                const receipt=await ports.inspect(intent);
                if(receipt.state!=='absent')return await saveReceipt(intent,receipt);
                requireValue(intent.phase!=='admitted','RECURRENCE_RECEIPT_REGRESSION');
                intent=await update(intent,row=>row.phase==='settled'?row:{...row,phase:'prepared',code:undefined,updatedAt:now()});
            }
            let claimed=false;
            intent=await update(intent,row=>{if(row.phase!=='prepared')return row;claimed=true;return {...row,phase:'submitting',updatedAt:now()};});
            if(!claimed)return intent;
            const receipt=await ports.submit(intent);const saved=await saveReceipt(intent,receipt);
            ports.log({operationId:intent.id,boardId:intent.boardId,stage:'recurrence.admit',result:'success',durationMs:now()-started});return saved;
        } catch(error) {
            const code=safeCode(error,'RECURRENCE_ADMISSION_UNKNOWN');
            const saved=await update(intent,row=>['settled','admitted'].includes(row.phase)?row:{...row,phase:'unknown',code,updatedAt:now()});
            ports.log({operationId:intent.id,boardId:intent.boardId,stage:'recurrence.admit',result:'failure',code,durationMs:now()-started});return saved;
        }
    }
    async function saveReceipt(intent:RecurrenceIntent,receipt:Exclude<Receipt,{state:'absent'}>):Promise<RecurrenceIntent> {
        return update(intent,row=>{
            if(row.phase==='settled'||row.phase==='admitted'&&receipt.state==='unknown')return row;
            if(receipt.state==='unknown')return {...row,phase:'unknown',code:receipt.code??'RECURRENCE_RECEIPT_UNKNOWN',updatedAt:now()};
            requireValue(!row.runId||row.runId===receipt.runId,'RECURRENCE_RECEIPT_CONFLICT');
            return {...row,phase:receipt.state,runId:receipt.runId,...(receipt.state==='settled'?{settledAt:receipt.settledAt??now()}:{}),code:undefined,updatedAt:now()};
        });
    }
    return {reserve,adopt,read,reconcile};
}
