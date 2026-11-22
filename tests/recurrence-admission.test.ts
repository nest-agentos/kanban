import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal} from '../src/runtime/automation-journal';
import {recurrenceAdmission} from '../src/runtime/recurrence-admission';
import type {KanbanProjectRecord} from '../src/contracts';

const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0))await close();});
async function fixture() {
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());
 const fs=await manager.openFileSystem('/'),journal=new KanbanAutomationJournal(fs);await journal.open();
 const record={id:'decision',kind:'decision',status:'confirmed',revision:7,createdAt:1,updatedAt:1,title:'Decision',content:'Scope',itemIds:[],sources:[],author:{kind:'human',id:'owner'},origin:'manual',recurrence:{state:'active',firstAt:1000,timeZone:'UTC',cadence:{kind:'interval',milliseconds:60000},trigger:'fixed',maxConcurrency:1}} as KanbanProjectRecord;
 const inspect=vi.fn(async():Promise<any>=>({state:'unknown'})),submit=vi.fn(async(intent):Promise<any>=>({state:'admitted',runId:intent.id})),log=vi.fn();
 const open=()=>recurrenceAdmission({journal,inspect,submit,log,now:()=>2000});return {record,inspect,submit,open,journal,log};
}
it('recovers the persisted intent after interruption before task creation',async()=>{
 const f=await fixture(),intent=await f.open().reserve('board',f.record,7,1000);
 expect(intent.phase).toBe('prepared');expect(f.submit).not.toHaveBeenCalled();
 const restarted=f.open(),result=await restarted.reconcile((await restarted.read('board','decision'))[0]);
 expect(result).toMatchObject({id:intent.id,phase:'admitted',runId:intent.id});expect(f.submit).toHaveBeenCalledOnce();
 expect((await restarted.reserve('board',f.record,7,1000)).id).toBe(intent.id);
});
it('holds unknown outcomes and skips serial slots without accumulating them',async()=>{
 const f=await fixture();f.submit.mockRejectedValueOnce(Object.assign(new Error('lost'),{code:'TRANSPORT_LOST'}));
 const engine=f.open(),first=await engine.reserve('board',f.record,7,1000);
 expect((await engine.reconcile(first)).phase).toBe('unknown');
 const skipped=await engine.reserve('board',f.record,7,61000);expect(skipped.phase).toBe('skipped');
 expect((await f.open().reconcile(first)).phase).toBe('unknown');expect(f.submit).toHaveBeenCalledOnce();
 expect(JSON.stringify(f.log.mock.calls)).not.toContain('lost');
 f.inspect.mockResolvedValueOnce({state:'settled',runId:first.id});await f.open().reconcile(first);
 expect((await engine.reserve('board',f.record,7,61000)).phase).toBe('skipped');
 expect((await engine.reserve('board',f.record,7,121000)).phase).toBe('prepared');
});
it('retains frozen configuration and allows bounded parallel rounds',async()=>{
 const f=await fixture(),engine=f.open();f.record.recurrence!.maxConcurrency=2;
 const first=await engine.reserve('board',f.record,7,1000),second=await engine.reserve('board',f.record,7,61000);
 expect((await engine.reserve('board',f.record,7,121000)).phase).toBe('skipped');
 f.record.recurrence!.state='paused';f.record.recurrence!.maxConcurrency=1;
 await expect(engine.reserve('board',f.record,8,181000)).rejects.toMatchObject({code:'RECURRENCE_NOT_ACTIVE'});
 expect(first.record.recurrence).toMatchObject({state:'active',maxConcurrency:2});expect(second.id).not.toBe(first.id);
 expect((await f.open().reconcile(first)).phase).toBe('admitted');
});
it('retries only after a definitive not-started receipt using the same identity',async()=>{
 const f=await fixture();f.submit.mockRejectedValueOnce(Object.assign(new Error('lost'),{code:'TRANSPORT_LOST'}));
 const engine=f.open(),first=await engine.reserve('board',f.record,7,1000);await engine.reconcile(first);
 f.inspect.mockResolvedValueOnce({state:'absent'});const result=await f.open().reconcile(first);
 expect(result).toMatchObject({phase:'admitted',id:first.id});expect(f.submit).toHaveBeenCalledTimes(2);
 expect(f.submit.mock.calls.map(call=>call[0].id)).toEqual([first.id,first.id]);
});
it('admits only one concurrent serial slot when independent workers race',async()=>{
 const f=await fixture();const [a,b]=await Promise.all([
  f.open().reserve('board',f.record,7,1000),f.open().reserve('board',f.record,7,61000),
 ]);
 expect([a.phase,b.phase].sort()).toEqual(['prepared','skipped']);
 expect(await f.open().read('board','decision')).toHaveLength(2);
});
