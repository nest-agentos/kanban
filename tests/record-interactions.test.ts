import {expect,it,vi} from 'vitest';
import {withRecordInteractions} from '../src/runtime/record-interactions';
import type {KanbanRecordSummary} from '../src/contracts';
const record={id:'decision',kind:'decision',status:'confirmed',createdAt:1,updatedAt:2,itemIds:['root'],sessionIds:[],progress:{state:'running',lastActivityAt:2,startedAt:1,participation:{reason:'running',targets:[{itemId:'a',title:'A',purpose:'execution',phase:'running'},{itemId:'b',title:'B',purpose:'execution',phase:'running'}]}}} as KanbanRecordSummary;
const item=(id:string,state:string,stale=false)=>({id,title:id,task:{phase:'running',sessionId:'session-'+id},execution:{sessionId:'session-'+id,resourceId:'/native/'+id,state,stale,lastActivityAt:3,observedAt:100}});
const journal={diagnostic:vi.fn()};
const page=(items=[record])=>({revision:1,total:items.length,items});
it('finds approvals across parallel participants in one metadata batch and routes to the actual Session',async()=>{
 const queryActivity=vi.fn(async()=>({items:[item('a','running'),item('b','waiting-approval')]}));
 const result=await withRecordInteractions(page(),'board',{queryActivity} as any,journal as any);
 expect(queryActivity).toHaveBeenCalledExactlyOnceWith('board',{ids:['a','b'],view:'all',limit:200});
 expect(result.items[0]).toMatchObject({attention:'waiting-input',progress:{state:'needs-action',reason:'authorization-required',startedAt:1,lastActivityAt:2,itemId:'b',sessionId:'session-b',interactions:[{kind:'approval',resourceId:'/native/b'}],participation:{reason:'needs-action',targets:[{itemId:'b'}]}}});
 expect(record.progress?.state).toBe('running');
});
it.each(['stale','mismatched','settled'])('does not surface %s authorization evidence',async mode=>{
 const row=item('b','waiting-approval',mode==='stale');if(mode==='mismatched')row.execution.sessionId='historical';if(mode==='settled')row.task.phase='completed';
 const result=(await withRecordInteractions(page(),'board',{queryActivity:async()=>({items:[row]})} as any,journal as any)).items[0];
 expect(result.attention).toBeUndefined();expect(result.progress?.state).toBe('running');
 expect(result.progress?.participation?.targets[1].resourceId).toBe(mode==='settled'?'/native/b':undefined);
});
it('never reopens completed, cancelled or archived decisions',async()=>{
 const queryActivity=vi.fn();
 await withRecordInteractions(page([{...record,progress:{...record.progress!,state:'completed'}},{...record,status:'cancelled'},{...record,archivedAt:20}]),'board',{queryActivity} as any,journal as any);
 expect(queryActivity).not.toHaveBeenCalled();
});
it('clears the display naturally after approval and keeps input requests distinct',async()=>{
 const queryActivity=vi.fn().mockResolvedValueOnce({items:[item('a','waiting-input')]}).mockResolvedValueOnce({items:[item('a','running')]});
 expect((await withRecordInteractions(page(),'board',{queryActivity} as any,journal as any)).items[0].progress?.reason).toBe('input-required');
 expect((await withRecordInteractions(page(),'board',{queryActivity} as any,journal as any)).items[0].progress?.state).toBe('running');
});
it('keeps other boards readable and diagnoses metadata failures without leaking messages',async()=>{
 const diagnostic=vi.fn(),queryActivity=vi.fn(async()=>{throw Object.assign(Error('PRIVATE_CONTENT'),{code:'EACCES'});});
 expect((await withRecordInteractions(page(),'board',{queryActivity} as any,{diagnostic} as any)).items[0]).toEqual(record);
 expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({stage:'record.interactions.read',result:'failure',code:'EACCES'}));
 expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('PRIVATE_CONTENT');
});

it('includes only fresh matching bound resources without an additional task lookup',async()=>{
 const queryActivity=vi.fn(async()=>({items:[item('a','running'),item('b','running',true)]}));
 const result=await withRecordInteractions(page(),'board',{queryActivity} as any,journal as any);
 expect(result.items[0].progress?.participation?.targets.map(target=>target.resourceId)).toEqual(['/native/a',undefined]);
 expect(queryActivity).toHaveBeenCalledOnce();expect(record.progress?.participation?.targets[0].resourceId).toBeUndefined();
});
