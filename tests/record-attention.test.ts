import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal} from '../src/runtime/automation-journal';
import {dismissRecordAttention,withRecordAttention} from '../src/runtime/record-attention';
import {recordAttentionFingerprint,type KanbanClient,type KanbanRecordSummary} from '../src/contracts';
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0))await close();});
async function fixture(){
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());
 const fs=await manager.openFileSystem('/'),diagnostic=vi.fn(),journal=new KanbanAutomationJournal(fs,{diagnostic});await journal.open();
 const record={id:'decision',kind:'decision',status:'confirmed',revision:2,createdAt:1,updatedAt:3,itemIds:['missing'],sessionIds:[],progress:{state:'checking',reason:'TASK_GROUP_UNAVAILABLE',lastActivityAt:3}} as KanbanRecordSummary;
 const service={read:async()=>({members:[{kind:'human',id:'owner',roles:['coordinator']}]}),currentPrincipal:async()=>({kind:'human',id:'owner'}),records:async()=>withRecordAttention({revision:2,total:1,items:[record]},'board',journal),recordConversations:async()=>[]} as unknown as KanbanClient;
 const request={recordId:'decision',operationId:'dismiss',action:'dismiss-attention' as const,attentionFingerprint:recordAttentionFingerprint(record)};
 return {fs,record,service,journal,request,diagnostic};
}
it('persists an idempotent acknowledgement without altering missing task state and retains it across reopening',async()=>{
 const f=await fixture(),writes=vi.spyOn(f.journal,'updateMany');
 await dismissRecordAttention(f.service,f.journal,'board',f.request);await dismissRecordAttention(f.service,f.journal,'board',f.request);
 expect(writes).toHaveBeenCalledOnce();expect(f.record.progress).toMatchObject({state:'checking',reason:'TASK_GROUP_UNAVAILABLE'});
 const reopened=new KanbanAutomationJournal(f.fs);await reopened.open();
 const page=await withRecordAttention({revision:2,total:1,items:[f.record]},'board',reopened);
 expect(page.items[0].attentionDismissal).toMatchObject({fingerprint:f.request.attentionFingerprint,actor:{kind:'human',id:'owner'}});
});
it('rejects stale acknowledgements and operation reuse while leaving a new issue visible',async()=>{
 const f=await fixture();await dismissRecordAttention(f.service,f.journal,'board',f.request);
 f.record.progress!.lastActivityAt=4;
 expect(recordAttentionFingerprint(f.record)).not.toBe(f.request.attentionFingerprint);
 await expect(dismissRecordAttention(f.service,f.journal,'board',{...f.request,operationId:'stale'})).rejects.toMatchObject({code:'DECISION_ATTENTION_CHANGED'});
 await expect(dismissRecordAttention(f.service,f.journal,'board',{...f.request,attentionFingerprint:recordAttentionFingerprint(f.record)})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 expect((await f.service.records('board')).items[0].attentionDismissal?.fingerprint).toBe(f.request.attentionFingerprint);
});
it('requires the authorized coordinator and reports failures without private exception text',async()=>{
 const f=await fixture();vi.spyOn(f.service,'currentPrincipal').mockResolvedValue({kind:'human',id:'other'});
 await expect(dismissRecordAttention(f.service,f.journal,'board',f.request)).rejects.toMatchObject({code:'COORDINATOR_REQUIRED'});
 expect(f.diagnostic).toHaveBeenCalledWith(expect.objectContaining({stage:'record.attention.dismiss',result:'failure',code:'COORDINATOR_REQUIRED'}));
 vi.spyOn(f.journal,'getMany').mockRejectedValue(Object.assign(Error('PRIVATE_CONTENT'),{code:'EIO'}));
 await expect(withRecordAttention({revision:2,total:1,items:[f.record]},'board',f.journal)).rejects.toMatchObject({code:'EIO'});
 expect(f.diagnostic).toHaveBeenCalledWith(expect.objectContaining({stage:'record.attention.read',result:'failure',code:'EIO'}));
 expect(JSON.stringify(f.diagnostic.mock.calls)).not.toContain('PRIVATE_CONTENT');
});

it('restores attention for a new native authorization request in the same task without counting observation time',()=>{
 const progress={state:'needs-action',reason:'authorization-required',lastActivityAt:3,interactions:[{kind:'approval',itemId:'task',sessionId:'session',resourceId:'/session',title:'Task',requestIds:['epoch:number:0']}]};
 const record={id:'decision',revision:1,progress} as KanbanRecordSummary,first=recordAttentionFingerprint(record);
 expect(recordAttentionFingerprint({...record,progress:{...record.progress!,interactions:[{...record.progress!.interactions![0],requestIds:['epoch:number:1']}]}})).not.toBe(first);
 expect(recordAttentionFingerprint(record)).toBe(first);
});
