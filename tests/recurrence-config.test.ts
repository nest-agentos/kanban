import {afterEach,expect,it} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule,SeqKanbanStore} from '../src';
import type {KanbanRecurrence} from '../src/contracts';
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0))await close();});
const config:KanbanRecurrence={state:'active',firstAt:1000,timeZone:'UTC',trigger:'fixed',maxConcurrency:1,cadence:{kind:'interval',milliseconds:60000}};
async function fixture(){
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());
 const service=createKanbanModule({store:await SeqKanbanStore.open(await manager.openFileSystem('/')),actor:{kind:'human',id:'owner'},authorize:async()=>{}});
 await service.create({id:'board',title:'Board',scope:{kind:'system'},members:[{kind:'human',id:'owner',roles:['coordinator'],responsibility:'Manage'}]});
 let n=0;const run=async(command:any)=>service.execute('board',{operationId:'operation-'+ ++n,expectedRevision:(await service.read('board')).revision,command});
 await run({type:'append-record',record:{id:'decision',kind:'decision',title:'Decision',content:'Scope',rationale:'Verify',itemIds:[],sources:[],recurrence:config}});
 await run({type:'review-record',recordId:'decision',accept:true});return {service,run};
}
it('persists schedule changes with revision checks without changing the linked tasks',async()=>{
 const f=await fixture(),before=await f.service.record('board','decision');
 await f.run({type:'configure-record-recurrence',recordId:'decision',expectedRecordRevision:before.revision,recurrence:{...config,state:'paused'}});
 const after=await f.service.record('board','decision');expect(after.recurrence?.state).toBe('paused');expect(after.recurrenceRevision).toBe(before.revision+1);expect(after.itemIds).toEqual(before.itemIds);
 await expect(f.run({type:'configure-record-recurrence',recordId:'decision',expectedRecordRevision:before.revision,recurrence:config})).rejects.toMatchObject({code:'RECURRENCE_REVISION_CONFLICT'});
});
it('rejects invalid time zones and concurrency without changing the saved configuration',async()=>{
 const f=await fixture(),before=await f.service.record('board','decision');
 for(const recurrence of [{...config,timeZone:'not/a-zone'},{...config,trigger:'after-settlement',maxConcurrency:2}])
  await expect(f.run({type:'configure-record-recurrence',recordId:'decision',expectedRecordRevision:before.revision,recurrence})).rejects.toBeDefined();
 expect((await f.service.record('board','decision')).recurrence).toEqual(config);
});
it('serializes reservation with pause and retains the previously frozen intent',async()=>{
 const f=await fixture(),before=await f.service.record('board','decision'),revision=before.recurrenceRevision!;
 const scheduledAt=before.recurrence!.firstAt;
  await f.run({type:'reserve-record-recurrence',recordId:'decision',configRevision:revision,scheduledAt});
  const reserved=await f.service.record('board','decision');expect(reserved.recurrenceFence?.pending).toHaveLength(1);
  await f.run({type:'configure-record-recurrence',recordId:'decision',expectedRecordRevision:reserved.revision,recurrence:{...config,state:'paused'}});
  const paused=await f.service.record('board','decision');expect(paused.recurrenceFence?.pending[0].record.recurrence?.state).toBe('active');
  await expect(f.run({type:'reserve-record-recurrence',recordId:'decision',configRevision:revision,scheduledAt:scheduledAt+60000})).rejects.toBeDefined();
  expect((await f.service.record('board','decision')).recurrenceFence?.pending).toHaveLength(1);
});
it('fences concurrent pause and reservation at the board revision',async()=>{
 const f=await fixture(),record=await f.service.record('board','decision'),board=await f.service.read('board');
 const pause={type:'configure-record-recurrence' as const,recordId:'decision',expectedRecordRevision:record.revision,recurrence:{...config,state:'paused' as const}};
 const reserve={type:'reserve-record-recurrence' as const,recordId:'decision',configRevision:record.recurrenceRevision!,scheduledAt:config.firstAt};
 const outcomes=await Promise.allSettled([
  f.service.execute('board',{operationId:'race-pause',expectedRevision:board.revision,command:pause}),
  f.service.execute('board',{operationId:'race-reserve',expectedRevision:board.revision,command:reserve}),
 ]);
 expect(outcomes.filter(row=>row.status==='fulfilled')).toHaveLength(1);
 if(outcomes[0].status==='fulfilled')await expect(f.run(reserve)).rejects.toMatchObject({code:'RECURRENCE_NOT_ACTIVE'});
 else {const current=await f.service.record('board','decision');await f.run({...pause,expectedRecordRevision:current.revision});expect((await f.service.record('board','decision')).recurrenceFence?.pending).toHaveLength(1);}
});
