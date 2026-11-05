import type {KanbanClient} from '../contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import type {KanbanOperationRecord,KanbanOperationPort} from './operation-contracts';
import {requireValue} from '../rules';
import {safeCode} from './diagnostics';
interface Options<T extends KanbanOperationRecord> {
    service:Pick<KanbanClient,'read'>;journal:KanbanAutomationJournal;key:string;record:T;port:KanbanOperationPort<T>;
}
/** A frozen record crosses the submission boundary once; response loss only triggers inspection. */
export async function coordinateOperation<T extends KanbanOperationRecord>(options:Options<T>):Promise<T> {
    const {journal,key,port}=options;let record=await journal.get<T>(key)??options.record;
    requireValue(record.fingerprint===options.record.fingerprint,'OPERATION_IDENTITY_CONFLICT');
    if(record.phase==='settled'||record.phase==='prepared'&&(await options.service.read(record.boardId)).lifecycle)return record;
    const started=Date.now();
    try {
        if(record.phase==='prepared') {
            if(!await journal.claim(key))return (await journal.get<T>(key))!;
            record={...record,phase:'submitting'};await port.start(record);
        }
        const observed=await port.inspect(record);
        const waiting=observed.state==='succeeded'&&observed.output===undefined;
        if(observed.state==='succeeded'&&!waiting)await port.validate?.(record,observed.output);
        const terminal=!waiting&&['succeeded','failed'].includes(observed.state);
        return await save(options,{...record,phase:terminal?'settled':record.phase,
            state:waiting?'unknown':observed.state,sessionId:observed.executionId,
            code:waiting?'OPERATION_RESULT_PENDING':observed.code,...(terminal?{result:observed.output}:{})});
    }catch(error) {
        const failure=port.classify?.(error)??{code:safeCode(error,'OPERATION_OBSERVATION_FAILED'),disposition:'unknown'};
        journal.diagnostic({operationId:record.id,boardId:record.boardId,itemId:record.itemId,stage:'operation.'+record.action,result:'failure',code:failure.code,durationMs:Date.now()-started});
        return save(options,{...record,phase:failure.disposition==='retry-unstarted'?'prepared':failure.disposition==='terminal'?'settled':record.phase,
            state:failure.disposition==='terminal'?'failed':'unknown',code:failure.code,...(failure.result!==undefined?{result:failure.result}:{})});
    }
}
async function save<T extends KanbanOperationRecord>({journal,key,port,record}:Options<T>,next:T):Promise<T> {
    const saved=await journal.update<T>(key,current=>{
        requireValue(current?.fingerprint===record.fingerprint,'OPERATION_IDENTITY_CONFLICT');
        return current.phase==='settled'?current:JSON.stringify(current)===JSON.stringify(next)?current:next;
    });
    await port.report?.(saved);return saved;
}
