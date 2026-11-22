import type {KanbanClient,KanbanCommand,KanbanRecordRunRequest,KanbanRecordExecution} from '../contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import {requireValue} from '../rules';
interface Confirmation {
    boardId:string;recordId:string;runKey:string;runOperationId:string;
    active():boolean;commit(command:KanbanCommand):Promise<void>;confirmed():Promise<void>;
    run(request:KanbanRecordRunRequest):Promise<KanbanRecordExecution>;
}
/** Host authorization precedes this use case; confirmation and execution keep separate durable identities. */
export async function confirmRecordExecution(service:KanbanClient,journal:KanbanAutomationJournal,input:Confirmation):Promise<KanbanRecordExecution|undefined>{
    requireValue(input.active(),'SERVICE_STOPPING');
    const record=await service.record(input.boardId,input.recordId);
    if(record.status==='draft')await input.commit({type:'review-record',recordId:input.recordId,accept:true});
    const current=await service.record(input.boardId,input.recordId);requireValue(current.kind==='decision'&&current.status==='confirmed','DECISION_NOT_CONFIRMED');
    const request=await journal.update<KanbanRecordRunRequest|{scheduled:true}>(input.runKey,old=>{
        if(old&&'scheduled' in old)return old;
        if(!old&&(record.recurrence||current.recurrence))return {scheduled:true};
        requireValue(!old||old.recordId===input.recordId&&old.operationId===input.runOperationId&&old.placement==='current-board','IDEMPOTENCY_CONFLICT');
        return old??{recordId:input.recordId,operationId:input.runOperationId,expectedRevision:current.revision,placement:'current-board'};
    });
    await input.confirmed();
    if('scheduled' in request)return;
    requireValue(input.active(),'SERVICE_STOPPING');return input.run(request);
}
/** The domain control entry remains the only writer; callers only reconcile its visible state. */
export async function advanceRecordCancellation(service:KanbanClient,boardId:string,recordId:string,operationId:string):Promise<void>{
    const record=await service.record(boardId,recordId);if(['cancelling','cancelled'].includes(record.status))return;
    requireValue(service.controlRecord,'RECORD_CONTROL_UNAVAILABLE');
    await service.controlRecord(boardId,{recordId,operationId,action:'cancel'});
    requireValue(['cancelling','cancelled'].includes((await service.record(boardId,recordId)).status),'DECISION_CANCELLATION_UNCONFIRMED');
}
