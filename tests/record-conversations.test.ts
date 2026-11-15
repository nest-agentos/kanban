import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal} from '../src/runtime/automation-journal';
import {createRecordConversations} from '../src/runtime/record-conversations';
const closes:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
async function fixture(){const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());const journal=new KanbanAutomationJournal(await manager.openFileSystem('/'));await journal.open();
 const port={prepare:vi.fn(async()=>({private:'HOST_BINDING'})),start:vi.fn(async()=>({sessionId:'native',resourceId:'/native/original'})),advance:vi.fn(async()=>({state:'clarifying' as const})),watch:vi.fn(async()=>vi.fn(async()=>{})),close:vi.fn(async()=>{})};
 const options={journal,service:{read:vi.fn(async()=>({id:'board'}))} as any,port,log:vi.fn()};return {options,journal,port};}
it('freezes creation identity, returns only public metadata and never duplicates a native session on retry',async()=>{
 const f=await fixture(),runtime=createRecordConversations(f.options);closes.push(()=>runtime.quiesce());
 const created=await runtime.startRecordConversation('board',{operationId:'conversation'});
 expect(created).toMatchObject({sessionId:'native',resourceId:'/native/original'});expect(created).not.toHaveProperty('binding');expect(created).not.toHaveProperty('phase');
 await runtime.startRecordConversation('board',{operationId:'conversation'});expect(f.port.start).toHaveBeenCalledTimes(1);expect(f.port.start.mock.calls[0][1]).toBe(true);
 await expect(runtime.startRecordConversation('other',{operationId:'conversation'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 expect(await runtime.recordConversations('board')).toHaveLength(1);
});
it('inspects the original unknown creation after restart rather than issuing another first submission',async()=>{
 const f=await fixture();f.port.start.mockRejectedValueOnce(Object.assign(new Error('Lost response'),{code:'EIO'}));
 const first=createRecordConversations(f.options);await expect(first.startRecordConversation('board',{operationId:'conversation'})).rejects.toMatchObject({code:'EIO'});await first.quiesce();
 const recovered=createRecordConversations(f.options);closes.push(()=>recovered.quiesce());await recovered.startRecordConversation('board',{operationId:'conversation'});
 expect(f.port.prepare).toHaveBeenCalledTimes(1);expect(f.port.start.mock.calls.map(call=>call[1])).toEqual([true,false]);
});
it('freezes both the primary resource and affected resources before preparation and preserves them on recovery',async()=>{
 const f=await fixture(),runtime=createRecordConversations(f.options);closes.push(()=>runtime.quiesce());
 const resources=[{system:'projects',id:'primary'},{system:'projects',id:'secondary'}],primaryResource=resources[0];
 f.port.prepare.mockRejectedValueOnce(Object.assign(Error('Grant changed'),{code:'ECONFLICT'}));
 await expect(runtime.startRecordConversation('board',{operationId:'scope',resources,primaryResource})).rejects.toMatchObject({code:'ECONFLICT'});
 await expect(runtime.startRecordConversation('board',{operationId:'scope',resources,primaryResource:resources[1]})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 const recovered=await runtime.startRecordConversation('board',{operationId:'scope'});
 expect(recovered).toMatchObject({resources,primaryResource});
 expect(f.port.prepare).toHaveBeenLastCalledWith('scope','board',resources,primaryResource);
 expect(f.port.start).toHaveBeenCalledTimes(1);
});
it('lets an unsubmitted legacy creation select its missing scope once, but never changes an unknown submitted binding',async()=>{
 const f=await fixture(),runtime=createRecordConversations(f.options);closes.push(()=>runtime.quiesce());
 await f.journal.update('record-conversation:legacy',()=>({id:'legacy',boardId:'board',state:'error',code:'ECONFLICT',phase:'prepared',createdAt:1}));
 expect((await runtime.recordConversations('board'))[0].scopeSelectionRequired).toBe(true);
 const resources=[{system:'projects',id:'main'}];
 expect(await runtime.startRecordConversation('board',{operationId:'legacy',resources,primaryResource:resources[0]})).toMatchObject({id:'legacy',resources,scopeSelectionRequired:false,sessionId:'native'});
 await f.journal.update('record-conversation:unknown',()=>({id:'unknown',boardId:'board',state:'error',phase:'submitting',createdAt:1,binding:{private:'original'}}));
 expect((await runtime.recordConversations('board')).find(row=>row.id==='unknown')?.scopeSelectionRequired).toBe(false);
 await expect(runtime.startRecordConversation('board',{operationId:'unknown',resources,primaryResource:resources[0]})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
});

it('updates activity only for meaningful conversation transitions and keeps it stable across observation reads',async()=>{
 const f=await fixture(),runtime=createRecordConversations(f.options);closes.push(()=>runtime.quiesce());
 const started=await runtime.startRecordConversation('board',{operationId:'activity'});
 expect(started.lastActivityAt).toBeGreaterThanOrEqual(started.createdAt);
 await runtime.startRecordConversation('board',{operationId:'activity'});expect((await runtime.recordConversations('board'))[0].lastActivityAt).toBe(started.lastActivityAt);
 f.port.advance.mockResolvedValueOnce({state:'draft'} as any);
 await runtime.startRecordConversation('board',{operationId:'activity'});const changed=(await runtime.recordConversations('board'))[0];expect(changed.state).toBe('draft');expect(changed.lastActivityAt).toBeGreaterThanOrEqual(started.lastActivityAt!);
});

async function controlledFixture(){
 const f=await fixture();f.options.service.read.mockResolvedValue({id:'board',members:[{kind:'human',id:'owner',roles:['coordinator']}]});
 f.options.service.currentPrincipal=vi.fn(async()=>({kind:'human',id:'owner'}));
 const runtime=createRecordConversations(f.options);closes.push(()=>runtime.quiesce());
 const value=await runtime.startRecordConversation('board',{operationId:'discussion'});
 return {...f,runtime,value};
}
it('acknowledges only the current discussion issue, preserves its outcome and restores attention after a new event',async()=>{
 const {conversationAttentionFingerprint}=await import('../src/contracts');const f=await controlledFixture();
 const fingerprint=conversationAttentionFingerprint(f.value);
 await f.runtime.controlRecordConversation('board',{conversationId:'discussion',operationId:'ack',action:'dismiss-attention',fingerprint});
 await f.runtime.controlRecordConversation('board',{conversationId:'discussion',operationId:'ack',action:'dismiss-attention',fingerprint});
 const saved=(await f.runtime.recordConversations('board'))[0];expect(saved.state).toBe('clarifying');
 expect(saved.attentionDismissal?.fingerprint).toBe(conversationAttentionFingerprint(saved));expect(f.port.start).toHaveBeenCalledOnce();
 await f.journal.update('record-conversation:discussion',old=>({...old as object,state:'error',code:'NEW_ERROR'}));
 const changed=(await f.runtime.recordConversations('board'))[0];expect(changed.attentionDismissal?.fingerprint).not.toBe(conversationAttentionFingerprint(changed));
 await expect(f.runtime.controlRecordConversation('board',{conversationId:'discussion',operationId:'stale',action:'dismiss-attention',fingerprint})).rejects.toMatchObject({code:'DECISION_ATTENTION_CHANGED'});
});
it('requires absence evidence and explicit confirmation, retains history, and stops observing a cleared reference',async()=>{
 const {conversationAttentionFingerprint}=await import('../src/contracts');const f=await controlledFixture(),check=vi.fn(async()=>true);
 Object.assign(f.port,{referenceUnavailable:check});const fingerprint=conversationAttentionFingerprint(f.value);
 const request={conversationId:'discussion',operationId:'cleanup',action:'cleanup-reference' as const,fingerprint};
 await expect(f.runtime.controlRecordConversation('board',request)).rejects.toMatchObject({code:'CONVERSATION_CLEANUP_CONFIRM_REQUIRED'});expect(check).not.toHaveBeenCalled();
 check.mockResolvedValueOnce(false);
 await expect(f.runtime.controlRecordConversation('board',{...request,confirmed:true})).rejects.toMatchObject({code:'CONVERSATION_REFERENCE_STILL_AVAILABLE'});
 await f.runtime.controlRecordConversation('board',{...request,confirmed:true});await f.runtime.controlRecordConversation('board',{...request,confirmed:true});
 expect(await f.runtime.recordConversations('board')).toHaveLength(0);
 expect(await f.journal.get('record-conversation:discussion')).toMatchObject({binding:{private:'HOST_BINDING'},sessionId:'native',clearedAt:expect.any(Number),state:'clarifying'});
 await f.runtime.scan();expect(f.port.start).toHaveBeenCalledOnce();
 await expect(f.runtime.startRecordConversation('board',{operationId:'discussion'})).rejects.toMatchObject({code:'CONVERSATION_REFERENCE_CLEARED'});
});
it('does not clear formal decisions or accept a reused operation identity for a different discussion',async()=>{
 const {conversationAttentionFingerprint}=await import('../src/contracts');const f=await controlledFixture();
 const request={conversationId:'discussion',operationId:'shared-control',action:'dismiss-attention' as const,fingerprint:conversationAttentionFingerprint(f.value)};
 await f.runtime.controlRecordConversation('board',request);
 await expect(f.runtime.controlRecordConversation('board',{...request,conversationId:'other'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 await f.journal.update('record-conversation:discussion',old=>({...old as object,recordId:'formal'}));
 const saved=(await f.runtime.recordConversations('board'))[0];
 await expect(f.runtime.controlRecordConversation('board',{...request,operationId:'formal-ack',fingerprint:conversationAttentionFingerprint(saved)})).rejects.toMatchObject({code:'CONVERSATION_HAS_RECORD'});
});

it('removes an available draft only after confirmation and host verification, with stable receipts and retained history',async()=>{
 const {conversationAttentionFingerprint}=await import('../src/contracts');const f=await controlledFixture(),verify=vi.fn(async()=>{});
 Object.assign(f.port,{verifyDraftRemoval:verify});const stop=await f.port.watch.mock.results[0].value;
 const request={conversationId:'discussion',operationId:'remove',action:'remove-draft' as const,fingerprint:conversationAttentionFingerprint(f.value),confirmed:true};
 await expect(f.runtime.controlRecordConversation('board',{...request,confirmed:false})).rejects.toMatchObject({code:'CONVERSATION_REMOVE_CONFIRM_REQUIRED'});
 expect(verify).not.toHaveBeenCalled();await f.runtime.controlRecordConversation('board',request);await f.runtime.controlRecordConversation('board',request);
 expect(verify).toHaveBeenCalledOnce();expect(stop).toHaveBeenCalledOnce();expect(await f.runtime.recordConversations('board')).toEqual([]);
 expect(await f.journal.get('record-conversation:discussion')).toMatchObject({clearedAt:expect.any(Number),sessionId:'native',state:'clarifying'});
 await f.runtime.scan();expect(f.port.start).toHaveBeenCalledOnce();
 await expect(f.runtime.startRecordConversation('board',{operationId:'discussion'})).rejects.toMatchObject({code:'CONVERSATION_REFERENCE_CLEARED'});
});
it('rejects draft removal without host evidence, after publication, when stale or without coordinator permission',async()=>{
 const {conversationAttentionFingerprint}=await import('../src/contracts');const f=await controlledFixture();
 const request={conversationId:'discussion',operationId:'remove',action:'remove-draft' as const,fingerprint:conversationAttentionFingerprint(f.value),confirmed:true};
 await expect(f.runtime.controlRecordConversation('board',request)).rejects.toMatchObject({code:'CONVERSATION_DRAFT_REMOVAL_UNAVAILABLE'});
 const verify=vi.fn(async()=>{throw Object.assign(Error('PRIVATE_BODY'),{code:'CONVERSATION_HAS_RECORD'});});Object.assign(f.port,{verifyDraftRemoval:verify});
 await expect(f.runtime.controlRecordConversation('board',request)).rejects.toMatchObject({code:'CONVERSATION_HAS_RECORD'});
 expect(await f.runtime.recordConversations('board')).toHaveLength(1);
 f.options.service.currentPrincipal.mockResolvedValueOnce({kind:'human',id:'other'});
 await expect(f.runtime.controlRecordConversation('board',request)).rejects.toMatchObject({code:'COORDINATOR_REQUIRED'});
 await f.journal.update('record-conversation:discussion',old=>({...old as object,state:'draft'}));
 await expect(f.runtime.controlRecordConversation('board',request)).rejects.toMatchObject({code:'DECISION_ATTENTION_CHANGED'});
 expect(JSON.stringify(f.options.log.mock.calls)).not.toContain('PRIVATE_BODY');
});

it('batches draft removals with per-entry authorization, receipts and bounded requests',async()=>{
 const {conversationAttentionFingerprint}=await import('../src/contracts');const f=await controlledFixture();Object.assign(f.port,{verifyDraftRemoval:async()=>{}});
 const request={conversationId:'discussion',operationId:'remove',action:'remove-draft' as const,fingerprint:conversationAttentionFingerprint(f.value),confirmed:true};
 const batch={requests:[request,{...request,conversationId:'missing',operationId:'missing'}]};
 expect(await f.runtime.removeRecordConversations('board',batch)).toEqual({items:[{conversationId:'discussion',outcome:'removed'},{conversationId:'missing',outcome:'failed',code:'CONVERSATION_NOT_FOUND'}]});
 expect(await f.runtime.removeRecordConversations('board',batch)).toEqual({items:[{conversationId:'discussion',outcome:'removed'},{conversationId:'missing',outcome:'failed',code:'CONVERSATION_NOT_FOUND'}]});
 await expect(f.runtime.removeRecordConversations('board',{requests:[request,request]})).rejects.toMatchObject({code:'INVALID_RECORD_CONTROL'});
 await expect(f.runtime.removeRecordConversations('board',{requests:Array.from({length:101},(_,n)=>({...request,conversationId:'draft-'+n}))})).rejects.toMatchObject({code:'INVALID_RECORD_CONTROL'});
});
