import {recordAttentionFingerprint,type KanbanClient,type KanbanRecordPage,type KanbanRecordSummary} from '../contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import {requireValue} from '../rules';
import {safeCode} from './diagnostics';
import {randomUUID} from '../utils';
type Dismissal=NonNullable<KanbanRecordSummary['attentionDismissal']>;
type Receipt=Dismissal&{board:string;record:string};
type Request=Parameters<NonNullable<KanbanClient['controlRecord']>>[1];
const key=(board:string,id:string)=>'record-attention-dismissal:'+JSON.stringify([board,id]);

export async function withRecordAttention(page:KanbanRecordPage,board:string,journal:KanbanAutomationJournal):Promise<KanbanRecordPage> {
    const decisions=page.items.filter(record=>record.kind==='decision');if(!decisions.length)return page;
    const started=Date.now();
    const saved=await journal.getMany<Dismissal>(decisions.map(record=>key(board,record.id))).catch(error=>{journal.diagnostic({operationId:randomUUID(),boardId:board,stage:'record.attention.read',result:'failure',code:safeCode(error,'RECORD_ATTENTION_READ_FAILED'),durationMs:Date.now()-started});throw error;}),byId=new Map(decisions.map((record,index)=>[record.id,saved[index]]));
    return {...page,items:page.items.map(record=>byId.get(record.id)?{...record,attentionDismissal:byId.get(record.id)}:record)};
}
/** Acknowledgement records user attention; it cannot settle, cancel or recreate work. */
export async function dismissRecordAttention(service:KanbanClient,journal:KanbanAutomationJournal,boardId:string,request:Request):Promise<void> {
    const started=Date.now(),operationId=/^[\w-]{1,128}$/.test(request.operationId)?request.operationId:'invalid-operation';
    try {await advanceDismissal(service,journal,boardId,request);journal.diagnostic({operationId,boardId,stage:'record.attention.dismiss',result:'success',durationMs:Date.now()-started});}
    catch(error){journal.diagnostic({operationId,boardId,stage:'record.attention.dismiss',result:'failure',code:safeCode(error,'RECORD_ATTENTION_DISMISS_FAILED'),durationMs:Date.now()-started});throw error;}
}
async function advanceDismissal(service:KanbanClient,journal:KanbanAutomationJournal,boardId:string,request:Request):Promise<void> {
    requireValue(/^[\w-]{1,128}$/.test(request.operationId)&&/^[a-f0-9]{64}$/.test(request.attentionFingerprint??''),'INVALID_RECORD_CONTROL');
    const [board,actor]=await Promise.all([service.read(boardId),service.currentPrincipal()]);
    requireValue(actor.kind==='human'&&board.members?.some(row=>row.kind===actor.kind&&row.id===actor.id&&row.roles?.includes('coordinator')),'COORDINATOR_REQUIRED');
    const operationKey='record-attention-operation:'+request.operationId,receipt=await journal.get<Receipt>(operationKey);
    if(receipt){requireValue(receipt.board===boardId&&receipt.record===request.recordId&&receipt.fingerprint===request.attentionFingerprint,'IDEMPOTENCY_CONFLICT');return;}
    const [page,conversations]=await Promise.all([service.records(boardId,{kind:'decision',includeArchived:true,limit:200}),service.recordConversations?.(boardId)??Promise.resolve([])]);
    const record=page.items.find(row=>row.id===request.recordId);requireValue(record,'RECORD_NOT_FOUND');
    const fingerprint=recordAttentionFingerprint(record,conversations);
    requireValue(fingerprint===request.attentionFingerprint,'DECISION_ATTENTION_CHANGED');
    const dismissal:Dismissal={fingerprint,operationId:request.operationId,actor,at:Date.now()};
    await journal.updateMany([{key:operationKey,change:old=>{const saved=old as Receipt|undefined;requireValue(!saved||saved.board===boardId&&saved.record===request.recordId&&saved.fingerprint===fingerprint,'IDEMPOTENCY_CONFLICT');return saved??{board:boardId,record:request.recordId,...dismissal};}},{key:key(boardId,record.id),change:()=>dismissal}]);
}
