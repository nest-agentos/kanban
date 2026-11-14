import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal} from '../src/runtime/automation-journal';
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of closes.splice(0).reverse())await close();});
const record=(id='decision',epoch?:string,archivedAt?:number)=>({id,kind:'decision',executionEpoch:epoch,archivedAt}) as any;
const run=(id:string,changes:Record<string,unknown>={})=>({id,recordId:'decision',recordRevision:1,boardId:'board',sourceBoardId:'source',createdAt:1,updatedAt:2,state:'running',record:{executionEpoch:'epoch',body:'PRIVATE_FROZEN_BODY'},automation:{executor:{id:'PRIVATE_CONFIGURATION'}},...changes});
async function fixture(legacy?:unknown[]) {
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());const original=await manager.openFileSystem('/'),native=original.meta.seq!;
 const seq=Object.fromEntries(['getEntry','getEntries','getEntriesMany','setEntry','setEntries','deleteEntry','walkEntries','transaction'].map(key=>[key,(...args:any[])=>(native as any)[key](...args)]));
 const fs=new Proxy(original,{get(target,key){if(key==='meta')return {...target.meta,seq};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as typeof original;
 if(legacy){await fs.driver.createFile({parentPath:'/runtime',name:'automation.seq',type:'seqfile',recursive:true});await fs.meta.seq!.setEntry('/runtime/automation.seq','record-runs:source',JSON.stringify(legacy));}
 const log=vi.fn(),journal=new KanbanAutomationJournal(fs,{directory:'/runtime',diagnostic:log});await journal.open();return {fs,journal,log};
}
it('migrates frozen history into per-run hot rows and separate immutable details without losing order or fields',async()=>{
 const original=[run('z'),run('a',{state:'completed',updatedAt:5}),run('other',{recordId:'other',unknownExtension:{kept:true}})],f=await fixture(original);
 expect(await f.journal.get('record-runs:source')).toEqual(original);
 expect(JSON.parse((await f.fs.meta.seq!.getEntry('/runtime/automation.seq','record-runs:source'))!)).toEqual({recordRuns:1,count:3});
 const batch=vi.spyOn(f.fs.meta.seq!,'getEntries');const rows=await f.journal.currentRuns('source',[record('decision','epoch')]);
 expect(rows.get('decision')).toMatchObject({id:'a',state:'completed',updatedAt:5,record:{executionEpoch:'epoch'}});
 expect(batch).toHaveBeenCalledOnce();expect(batch.mock.calls[0][1]).toEqual(['current:["source","decision","epoch",false]']);
 expect(JSON.stringify([...rows.values()])).not.toContain('PRIVATE');
 expect(f.log).toHaveBeenCalledWith(expect.objectContaining({stage:'record.progress.storage',readCount:1,count:1,bytes:expect.any(Number)}));
 const restored=new KanbanAutomationJournal(f.fs,{directory:'/runtime'});await restored.open();expect(await restored.get('record-runs:source')).toEqual(original);
});
it('preserves epoch, archive and tie selection and updates high-frequency fields without rewriting details',async()=>{
 const values=[run('first'),run('tie'),run('archived',{archivedAt:5,createdAt:4}),run('new-epoch',{record:{executionEpoch:'new'},createdAt:9})],f=await fixture(values);
 expect((await f.journal.currentRuns('source',[record('decision','epoch')])).get('decision')?.id).toBe('first');
 expect((await f.journal.currentRuns('source',[record('decision','epoch',20)])).get('decision')?.id).toBe('archived');
 const writes:string[]=[],seq=f.fs.meta.seq!,transaction=seq.transaction!.bind(seq);
 vi.spyOn(seq,'transaction').mockImplementation(work=>transaction(tx=>work(new Proxy(tx,{get(target,key){if(key==='setEntry')return async(path:string,field:string,value:string)=>{writes.push(field);return target.setEntry(path,field,value);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}))));
 await f.journal.update<any[]>('record-runs:source',old=>old!.map(row=>row.id==='tie'?{...row,state:'completed',updatedAt:8}:row));
 expect(writes.some(key=>key.startsWith('detail:'))).toBe(false);expect(writes.filter(key=>key.startsWith('run:'))).toEqual(['run:["source","tie"]']);
 expect((await f.journal.currentRuns('source',[record('decision','epoch')])).get('decision')).toMatchObject({id:'tie',state:'completed'});
 expect((await f.journal.currentRuns('source',[record('decision','new')])).get('decision')?.id).toBe('new-epoch');
});
it('rolls hot rows, current indexes and the journal reference back together on persistence failure',async()=>{
 const f=await fixture([run('one')]),seq=f.fs.meta.seq!,transaction=seq.transaction!.bind(seq);
 const failed=vi.spyOn(seq,'transaction').mockImplementation(work=>transaction(tx=>work(new Proxy(tx,{get(target,key){if(key==='setEntry')return async(path:string,field:string,value:string)=>{if(field.startsWith('current:'))throw Object.assign(Error('PRIVATE_FAILURE'),{code:'ENOSPC'});return target.setEntry(path,field,value);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}))));
 await expect(f.journal.update<any[]>('record-runs:source',old=>old!.map(row=>({...row,state:'completed',updatedAt:10})))).rejects.toMatchObject({code:'ENOSPC'});failed.mockRestore();
 expect(await f.journal.get('record-runs:source')).toEqual([run('one')]);expect((await f.journal.currentRuns('source',[record('decision','epoch')])).get('decision')?.state).toBe('running');
});
it('reads only requested current summaries for a large history and preserves board lookup semantics',async()=>{
 const values=Array.from({length:1200},(_,i)=>run('run-'+i,{recordId:'record-'+i,record:{executionEpoch:'epoch',body:'PRIVATE_LARGE_BODY'.repeat(256)}})),f=await fixture(values);
 const batch=vi.spyOn(f.fs.meta.seq!,'getEntries'),walk=vi.spyOn(f.fs.meta.seq!,'walkEntries');
 const rows=await f.journal.currentRuns('source',[record('record-1','epoch'),record('record-900','epoch')]);
 expect(rows.size).toBe(2);expect(batch).toHaveBeenCalledOnce();expect(walk).not.toHaveBeenCalled();
 const bytes=f.log.mock.calls.filter(([event])=>event.stage==='record.progress.storage').at(-1)![0].bytes;expect(bytes).toBeLessThan(1024);expect(JSON.stringify(values).length).toBeGreaterThan(5000000);
 expect((await f.journal.findForBoard<any[]>('record-runs:','source',rows=>rows.length>0))[0].value).toHaveLength(1200);
 expect((await f.journal.find<any[]>('record-runs:',rows=>rows.length>0))[0].value).toEqual(values);
});
it('removes obsolete current entries and can rebuild the board index from normalized history',async()=>{
 const f=await fixture([run('one')]);await f.fs.meta.seq!.deleteEntry('/runtime/automation-board-index.seq','version');await f.journal.open();
 expect(await f.journal.findForBoard('record-runs:','source',()=>true)).toHaveLength(1);
 await f.journal.updateMany([{key:'record-runs:source',change:()=>[]},{key:'receipt',change:()=>({done:true})}]);
 expect((await f.journal.currentRuns('source',[record('decision','epoch')])).size).toBe(0);expect(await f.journal.get('record-runs:source')).toEqual([]);expect(await f.journal.get('receipt')).toEqual({done:true});
});

it('checkpoints one execution without reading other frozen histories and keeps healthy observation times unchanged',async()=>{
 const one=run('one'),f=await fixture([one,run('other',{recordId:'other',record:{executionEpoch:'other',body:'PRIVATE_OTHER'}})]);
 const read=vi.fn(),walk=vi.fn(),batch=vi.fn(),seq=f.fs.meta.seq!,transaction=seq.transaction!.bind(seq);
 vi.spyOn(seq,'transaction').mockImplementation(work=>transaction(tx=>work(new Proxy(tx,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return (...args:any[])=>{if(key==='getEntry')read(...args);if(key==='walkEntries')walk(...args);if(key==='getEntries')batch(...args);return value.apply(target,args);};}}))));
 const changed=await f.journal.saveRun('source',{...one,state:'completed',updatedAt:20} as any);
 expect(changed).toMatchObject({state:'completed',updatedAt:20});expect(batch).not.toHaveBeenCalled();
 expect(read.mock.calls.some(([,key])=>key.startsWith('detail:')||key.startsWith('record-runs:'))).toBe(false);
 expect(walk).toHaveBeenCalledExactlyOnceWith('/runtime/record-runs.seq',expect.any(Function),{keyPrefix:'by-record:["source","decision","epoch",'});
 expect(await f.journal.saveRun('source',{...changed,updatedAt:999} as any)).toMatchObject({updatedAt:20});
 expect((await f.journal.currentRuns('source',[record('decision','epoch')])).get('decision')).toMatchObject({state:'completed',updatedAt:20});
});
it('filters recovery through the active index and reads history summaries without frozen details',async()=>{
 const f=await fixture([run('done',{state:'completed',record:{executionEpoch:'epoch',body:'PRIVATE_DONE'}}),run('live',{recordId:'live',record:{executionEpoch:'live',body:'PRIVATE_LIVE'}})]);
 const batch=vi.spyOn(f.fs.meta.seq!,'getEntries'),walk=vi.spyOn(f.fs.meta.seq!,'walkEntries');
 expect(await f.journal.runSummaries('source','decision')).toEqual([expect.objectContaining({id:'done',state:'completed'})]);expect(batch).not.toHaveBeenCalled();
 expect(walk).toHaveBeenLastCalledWith('/runtime/record-runs.seq',expect.any(Function),{keyPrefix:'by-record:["source","decision",'});
 const rows=await f.journal.activeRuns<any>('source');expect(rows.map(row=>row.id)).toEqual(['live']);expect(rows[0].record.body).toBe('PRIVATE_LIVE');
 expect(batch).toHaveBeenCalledOnce();expect(batch.mock.calls[0][1]).toHaveLength(1);
 await f.journal.saveRun('source',{...rows[0],state:'completed',updatedAt:10});expect(await f.journal.activeRuns('source')).toEqual([]);
});
it('reports a failed checkpoint and rolls its hot and index writes back without logging frozen data',async()=>{
 const f=await fixture([run('one')]),seq=f.fs.meta.seq!,transaction=seq.transaction!.bind(seq);
 const failed=vi.spyOn(seq,'transaction').mockImplementation(work=>transaction(tx=>work(new Proxy(tx,{get(target,key){if(key==='setEntry')return async(path:string,field:string,value:string)=>{if(field.startsWith('current:'))throw Object.assign(Error('PRIVATE_FAILURE'),{code:'ENOSPC'});return target.setEntry(path,field,value);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}))));
 await expect(f.journal.saveRun('source',{...run('one'),state:'completed',updatedAt:10} as any)).rejects.toMatchObject({code:'ENOSPC'});failed.mockRestore();
 expect((await f.journal.activeRuns<any>('source'))[0]).toMatchObject({id:'one',state:'running'});
 expect(f.log).toHaveBeenCalledWith(expect.objectContaining({stage:'record.runs.checkpoint',result:'failure',code:'ENOSPC',operationId:expect.any(String),durationMs:expect.any(Number)}));expect(JSON.stringify(f.log.mock.calls)).not.toContain('PRIVATE');
});
