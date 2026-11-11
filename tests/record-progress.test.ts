import {expect,it,vi} from 'vitest';
import {recordProgress} from '../src/record-progress';
import {recordAttention} from '../src/attention';
import {withRecordProgress} from '../src/runtime/record-progress';
import type {KanbanRecordSummary,KanbanTaskPhase} from '../src/contracts';
const record={id:'decision',kind:'decision',status:'confirmed',createdAt:1,updatedAt:2,itemIds:['root'],sessionIds:[]} as KanbanRecordSummary;
const fact=(id:string,phase:KanbanTaskPhase,at=5)=>({item:{id,title:id,status:phase==='completed'?'completed':'open',createdAt:1,updatedAt:at,planning:{kind:'work',dependencies:[],references:[],priority:1},sessionIds:[]} as any,task:{phase,actions:[],sessionId:'session-'+id,reason:phase==='error'?'BUILD_FAILED':undefined}});
it.each([['queued','waiting'],['waiting-dependency','waiting'],['paused','waiting'],['analyzing','running'],['running','running'],['preparing','running'],['review','needs-action'],['waiting-input','needs-action'],['error','failed'],['unknown','checking'],['cancelled','failed']])('projects %s business progress as %s', (phase,state)=>{
 expect(recordProgress(record,[fact('root',phase as KanbanTaskPhase)])).toMatchObject({state,lastActivityAt:5,itemId:'root',sessionId:'session-root'});
});
it('requires every linked task to settle and never substitutes an unknown result for success',()=>{
 expect(recordProgress({...record,itemIds:['a','b']},[fact('a','completed'),fact('b','review')])).toMatchObject({state:'needs-action',reason:'acceptance-required'});
 expect(recordProgress({...record,itemIds:['a','b']},[fact('a','completed'),fact('b','unknown')])).toMatchObject({state:'checking'});
 expect(recordProgress({...record,itemIds:['a','b']},[fact('a','completed'),fact('b','completed')])).toMatchObject({state:'completed'});
 expect(recordProgress({...record,itemIds:[]},[])).toMatchObject({state:'waiting'});
});
it('retains archived task results and their actual activity time instead of using read time',()=>{
 const item=fact('root','completed',9).item;
 const state={workflow:{},archiveIndex:[{...item,archivedAt:10}]} as any;
 const archived={...record,archivedAt:10};
 expect(recordAttention(state,[],[archived])[0]).toMatchObject({archivedAt:10,progress:{state:'completed',lastActivityAt:9},attention:undefined});
 expect(recordAttention(state,[],[archived])[0].progress).toEqual(recordAttention(state,[],[archived])[0].progress);
});
it('aggregates a whole page with one read and keeps task-group completion authoritative',async()=>{
 const page={revision:1,total:2,items:[{...record,progress:{state:'completed' as const,lastActivityAt:9}},{...record,id:'other'}]};
 const journal={get:vi.fn(async()=>[{id:'run',recordId:'decision',recordRevision:1,boardId:'target',rootItemId:'root',createdAt:2,updatedAt:12,state:'review',stage:'execution'}]),diagnostic:vi.fn()};
 const result=await withRecordProgress(page,'board',journal as any);
 expect(journal.get).toHaveBeenCalledExactlyOnceWith('record-runs:board');
 expect(result.items[0].progress).toMatchObject({state:'completed',lastActivityAt:12,boardId:'target'});
 expect(result.items[1]).toEqual(page.items[1]);
 journal.get.mockResolvedValueOnce([{id:'run',recordId:'decision',recordRevision:1,boardId:'target',rootItemId:'root',createdAt:2,updatedAt:12,state:'completed',stage:'execution'}]);
 expect((await withRecordProgress(page,'board',journal as any)).items[0].progress?.state).toBe('completed');
});
it('keeps completed and failed outcomes alongside archive metadata and ignores another execution epoch',async()=>{
 const journal={get:vi.fn(async()=>[{id:'run',recordId:'decision',boardId:'b',createdAt:2,updatedAt:12,state:'completed',record:{executionEpoch:'old'}}]),diagnostic:vi.fn()};
 const archived={...record,status:'cancelled' as const,archivedAt:20,executionEpoch:'old',progress:{state:'cancelled' as const,lastActivityAt:20}};
 const page={revision:1,total:1,items:[archived]};
 expect((await withRecordProgress(page,'b',journal as any)).items[0]).toMatchObject({archivedAt:20,progress:{state:'completed',lastActivityAt:20}});
 expect((await withRecordProgress({...page,items:[{...archived,executionEpoch:'new'}]},'b',journal as any)).items[0].progress?.state).toBe('cancelled');
});
it('reports a precise read failure without including private error text',async()=>{
 const journal={get:vi.fn(async()=>{throw Object.assign(Error('PRIVATE_CONTENT'),{code:'EIO'});}),diagnostic:vi.fn()};
 await expect(withRecordProgress({revision:1,total:1,items:[record]},'b',journal as any)).rejects.toMatchObject({code:'EIO'});
 expect(journal.diagnostic).toHaveBeenCalledWith(expect.objectContaining({stage:'record.progress.read',result:'failure',code:'EIO'}));
 expect(JSON.stringify(journal.diagnostic.mock.calls)).not.toContain('PRIVATE_CONTENT');
});

it('does not let an archived cancelled attempt hide the active replacement root',()=>{
 const old={...fact('old','cancelled',8).item,status:'cancelled',archivedAt:9};
 const active={...fact('new','running',12).item,status:'claimed'};
 const state={workflow:{},archiveIndex:[old]} as any;
 expect(recordAttention(state,[active],[{...record,itemIds:['old','new']}])[0].progress).toMatchObject({state:'running',itemId:'new',lastActivityAt:12});
});

it('chooses the concrete failing task and Session rather than its aggregate group error',()=>{
 const group={...fact('group','error'),item:{...fact('group','error').item,planning:{execution:'children'}},task:{phase:'error' as const,reason:'GROUP_CHILD_ERROR',actions:[]}};
 const child=fact('child','error');
 expect(recordProgress({...record,itemIds:['group']},[group,{...child,item:{...child.item,planning:{parentId:'group'}}}])).toMatchObject({state:'failed',reason:'BUILD_FAILED',itemId:'child',sessionId:'session-child'});
});

it('keeps a settled group completed and reports its waiver even if an old descendant still has an issue',()=>{
 const root={...fact('root','completed'),item:{...fact('root','completed').item,planning:{execution:'children'}},task:{phase:'completed' as const,completion:'waived' as const,actions:[]}};
 const child={...fact('child','error'),item:{...fact('child','error').item,planning:{parentId:'root'}}};
 expect(recordProgress(record,[root,child])).toMatchObject({state:'completed',completion:'waived',groupIds:['root']});
});
it('does not let descendants of a settled group mask a different active task group',()=>{
 const root=fact('root','completed'),old={...fact('old-child','unknown'),item:{...fact('old-child','unknown').item,planning:{parentId:'root'}}},active=fact('active','running');
 expect(recordProgress({...record,itemIds:['root','active']},[root,old,active])).toMatchObject({state:'running',itemId:'active'});
});
it('keeps a missing task group unconfirmed instead of treating a partial set as completed',()=>{
 expect(recordProgress({...record,itemIds:['root','missing']},[fact('root','completed')])).toMatchObject({state:'checking',reason:'TASK_GROUP_UNAVAILABLE'});
});

it('uses the current attempt instead of deleted historical links and batches multiple decisions on one board',async()=>{
 const historical={...record,itemIds:['deleted','root'],executionEpoch:'current',progress:{state:'checking',reason:'TASK_GROUP_UNAVAILABLE',groupIds:['deleted'],lastActivityAt:5},attention:'error'} as KanbanRecordSummary;
 const journal={get:vi.fn(async()=>[
  {id:'old',recordId:'decision',record:{executionEpoch:'old'},boardId:'board',itemIds:['deleted'],state:'cancelled',createdAt:1,updatedAt:1},
  {id:'current',recordId:'decision',record:{executionEpoch:'current'},boardId:'board',itemIds:['root'],state:'completed',createdAt:2,updatedAt:9},
  {id:'second',recordId:'other',boardId:'board',itemIds:['second'],state:'running',createdAt:2,updatedAt:8},
 ]),diagnostic:vi.fn()};
 const complete=fact('root','completed'),active=fact('second','running');
 const service={query:vi.fn(async()=>({revision:1,total:2,items:[{...complete.item,task:complete.task},{...active.item,task:active.task}]}))};
 const page={revision:1,total:2,items:[historical,{...record,id:'other',itemIds:['old','second']}]};
 const result=await withRecordProgress(page,'board',journal as any,service as any);
 expect(service.query).toHaveBeenCalledExactlyOnceWith('board',{ids:['root','second'],view:'all',includeDeleted:true,limit:200});
 expect(result.items[0]).toMatchObject({itemIds:['deleted','root'],progress:{state:'completed',groupIds:['root'],itemId:'root'},attention:undefined,attentionTasks:[]});
 expect(result.items[0].progress?.reason).toBeUndefined();
 expect(result.items[1].progress).toMatchObject({state:'running',itemId:'second',groupIds:['second']});
});
it('keeps a genuinely missing current group checking even if a saved execution says completed',async()=>{
 const journal={get:vi.fn(async()=>[{id:'current',recordId:'decision',boardId:'target',itemIds:['root'],state:'completed',createdAt:2,updatedAt:9}]),diagnostic:vi.fn()};
 const service={query:vi.fn(async()=>({revision:1,total:0,items:[]}))};
 const result=await withRecordProgress({revision:1,total:1,items:[record]},'source',journal as any,service as any);
 expect(result.items[0].progress).toMatchObject({state:'checking',reason:'TASK_GROUP_UNAVAILABLE',groupIds:['root'],boardId:'target'});
});
it('does not let an archived attempt override active local work and reports summary read failures safely',async()=>{
 const journal={get:vi.fn(async()=>[{id:'old',recordId:'decision',boardId:'target',itemIds:['old'],state:'completed',archivedAt:10,createdAt:2,updatedAt:9}]),diagnostic:vi.fn()};
 const service={query:vi.fn(async()=>{throw Object.assign(Error('PRIVATE_CONTENT'),{code:'EIO'});})};
 const page={revision:1,total:1,items:[{...record,progress:{state:'running' as const,groupIds:['root'],lastActivityAt:5}}]};
 expect((await withRecordProgress(page,'source',journal as any,service as any)).items[0].progress?.state).toBe('running');
 expect(service.query).not.toHaveBeenCalled();
 journal.get.mockResolvedValueOnce([{id:'current',recordId:'decision',boardId:'target',itemIds:['root'],state:'running',createdAt:2,updatedAt:9}] as any);
 await expect(withRecordProgress(page,'source',journal as any,service as any)).rejects.toMatchObject({code:'EIO'});
 expect(journal.diagnostic).toHaveBeenCalledWith(expect.objectContaining({stage:'record.progress.groups',result:'failure',code:'EIO'}));
 expect(JSON.stringify(journal.diagnostic.mock.calls)).not.toContain('PRIVATE_CONTENT');
});
