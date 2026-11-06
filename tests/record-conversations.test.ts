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
