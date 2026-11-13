import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {automaticDelivery} from '@nestos/kanban/integration';
const closes:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of closes.splice(0))await close();});
it('advances host-defined actions without built-in development stages',async()=>{
 const f=await fixture(),steps=['inspect','store','approve','compare','apply','release'];
 f.options.policy={steps,finalizeAction:'release',handoffAction:'approve',refreshAction:'compare',refreshableActions:['compare','apply'],refreshCodes:[],unstartedCodes:[]};
 f.options.view=async()=>({revision:'r',operations:steps.map(id=>f.jobs.get(id)??{id,enabled:true,state:'ready'})});
 f.options.run=vi.fn(async(_board,request)=>{f.jobs.set(request.action,{id:request.action,runId:request.operationId,state:'succeeded',enabled:true});});
 for(let n=0;n<14;n++)await automaticDelivery(f.options).scan();
 expect(f.options.run.mock.calls.map(row=>row[1].action)).toEqual(steps.slice(0,-1));
 expect(f.options.cleanup).toHaveBeenCalledOnce();expect(await automaticDelivery(f.options).ready('b',f.item as never)).toBe(true);
});
async function fixture(){const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());const journal=new KanbanAutomationJournal(await manager.openFileSystem('/'));await journal.open();
 const item={id:'task',status:'review',planning:{kind:'task'}},board={id:'b',automation:{enabled:true},items:[item]},jobs=new Map<string,any>();
 const run=vi.fn(async(_board,request)=>{jobs.set(request.action,{id:request.action,runId:request.operationId,state:'succeeded',enabled:true});if(request.action==='accept')item.status='completed';return {revision:'revision',operations:[...jobs.values()]};});
 const view=vi.fn(async()=>({revision:'revision',operations:['build','deploy','accept','analyze','merge'].map(id=>jobs.get(id)??{id,enabled:true,state:'ready'})}));
 const policy={steps:['build','deploy','accept','analyze','merge','cleanup'],finalizeAction:'cleanup',handoffAction:'accept',refreshAction:'analyze',refreshableActions:['analyze','merge'],refreshCodes:['OPERATION_SOURCE_CHANGED_REANALYZE','OPERATION_TARGET_CHANGED_REANALYZE','MERGE_PLAN_SOURCE_CHANGED'],unstartedCodes:['OPERATION_ORIGINAL_SESSION_BUSY','OPERATION_WORKSPACE_BUSY','OPERATION_STALE_REFRESH']};
 const options={policy,service:{catalog:async()=>[{id:'b'}],read:async()=>board,item:async(_board,id)=>({item:board.items.find(row=>row.id===id)}),workflow:async()=>({dispatches:{d:{id:'d',itemId:'task',attempt:1,outcome:'succeeded'}}})},journal,active:()=>true,automatic:async()=>true,view,run,cleanup:vi.fn(async()=>true),report:vi.fn()} as any;
 return {options,journal,run,jobs,item,board};}
it('resumes all approved stages once and releases dependencies only after verified cleanup',async()=>{const f=await fixture();
 for(let n=0;n<12;n++){await automaticDelivery(f.options).scan();if(n<10)expect(await automaticDelivery(f.options).ready('b',f.item as never)).toBe(false);}
 expect(f.run.mock.calls.map(call=>call[1].action)).toEqual(['build','deploy','accept','analyze','merge']);expect(f.options.cleanup).toHaveBeenCalledOnce();expect(await automaticDelivery(f.options).ready('b',f.item as never)).toBe(true);
 await automaticDelivery(f.options).scan();expect(f.run).toHaveBeenCalledTimes(5);
});
it('never repeats an unknown operation and blocks at unapproved conflict choices',async()=>{const f=await fixture();await automaticDelivery(f.options).scan();
 f.jobs.get('build').state='unknown';for(let n=0;n<3;n++)await automaticDelivery(f.options).scan();expect(f.run).toHaveBeenCalledOnce();f.jobs.get('build').state='succeeded';
 for(let n=0;n<12&&!f.jobs.has('analyze');n++)await automaticDelivery(f.options).scan();
 expect(f.jobs.has('analyze')).toBe(true);
 f.options.view=async()=>({revision:'revision',operations:[...f.jobs.values(),{id:'merge',enabled:true,fields:[{id:'conflict'}]}]});await automaticDelivery(f.options).scan();await automaticDelivery(f.options).scan();
 expect(f.options.report).toHaveBeenCalledWith(expect.objectContaining({code:'OPERATION_SELECTION_REQUIRED'}));expect(f.run.mock.calls.some(call=>call[1].action==='merge')).toBe(false);
});

it('cleans completed task groups without creating a second build or deployment',async()=>{const f=await fixture();
 f.item.status='completed';(f.item.planning as any).execution='children';f.options.service.workflow=async()=>({dispatches:{}});
 f.options.cleanup.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
 await automaticDelivery(f.options).scan();expect(await automaticDelivery(f.options).ready('b',f.item as never)).toBe(false);
 await automaticDelivery(f.options).scan();expect(await automaticDelivery(f.options).ready('b',f.item as never)).toBe(true);expect(f.run).not.toHaveBeenCalled();
});

it('waits for a user-confirmed conflict resolution and cleans only after its verified merge',async()=>{
 const f=await fixture();for(let n=0;n<8;n++)await automaticDelivery(f.options).scan();
 f.options.view=async()=>({revision:'r',operations:[...f.jobs.values(),{id:'merge',enabled:true,fields:[{id:'conflict'}]}]});
 await automaticDelivery(f.options).scan();await automaticDelivery(f.options).scan();expect(f.options.cleanup).not.toHaveBeenCalled();
 f.options.view=async()=>({revision:'r',operations:[{id:'merge',state:'running',runId:'user-merge'}]});await automaticDelivery(f.options).scan();expect(f.options.cleanup).not.toHaveBeenCalled();
 f.options.view=async()=>({revision:'r',operations:[{id:'merge',state:'succeeded',runId:'user-merge'}]});await automaticDelivery(f.options).scan();
 expect(f.options.cleanup).toHaveBeenCalledOnce();expect(await automaticDelivery(f.options).ready('b',f.item as never)).toBe(true);
 expect(f.run.mock.calls.some(call=>call[1].action==='merge')).toBe(false);
});

it('adopts a verified manual rebuild after a failure without replaying the failed automatic request',async()=>{
 const f=await fixture();await automaticDelivery(f.options).scan();f.jobs.get('build').state='failed';await automaticDelivery(f.options).scan();
 f.jobs.set('build',{id:'build',runId:'confirmed-manual-rebuild',state:'succeeded',enabled:true});await automaticDelivery(f.options).scan();
 expect(f.run.mock.calls.map(call=>call[1].action)).toEqual(['build','deploy']);
});

it('serializes finalization for the same target while leaving development independent',async()=>{
 const f=await fixture(),second={...f.item,id:'second'};f.board.items.push(second);f.options.target=()=> 'project';
 f.options.service.workflow=async()=>({dispatches:{a:{id:'a',itemId:'task',attempt:1,outcome:'succeeded'},b:{id:'b',itemId:'second',attempt:1,outcome:'succeeded'}}});
 const jobs=new Map<string,any>();f.options.view=async(_b,id)=>({revision:'r',operations:['build','deploy','accept','analyze','merge'].map(action=>jobs.get(id+action)??{id:action,enabled:true,state:'ready'})});
 f.options.run=vi.fn(async(_b,request)=>{jobs.set(request.itemId+request.action,{id:request.action,runId:request.operationId,state:'succeeded',enabled:true});if(request.action==='accept')f.board.items.find(row=>row.id===request.itemId)!.status='completed';});
 await automaticDelivery(f.options).scan();await automaticDelivery(f.options).scan();expect(f.options.run.mock.calls.map(call=>call[1].itemId)).toEqual(['task']);
 for(let n=0;n<10;n++)await automaticDelivery(f.options).scan();
 expect(f.options.cleanup).toHaveBeenCalledWith('b','task',expect.any(String));expect(f.options.run.mock.calls.some(call=>call[1].itemId==='second')).toBe(true);
});
it('releases a legacy shared-target reservation when only independent finalization is blocked',async()=>{
 const f=await fixture(),next={...f.item,id:'next',planning:{...f.item.planning}};f.item.status='completed';(f.item.planning as any).execution='children';f.board.items.push(next);
 f.options.target=()=> 'project';f.options.policy.targetActions=['build','deploy','accept','analyze','merge'];
 f.options.service.workflow=async()=>({dispatches:{next:{id:'next-run',itemId:'next',attempt:1,outcome:'succeeded'}}});
 const storageKey='automatic-delivery:'+JSON.stringify(['b','task']);
 await f.journal.update(storageKey,()=>({id:'legacy',boardId:'b',itemId:'task',executionId:'task',target:'project',step:0,steps:['cleanup'],code:'ASSOCIATION_UNKNOWN',cleanupPrecondition:true,requests:{}}));
 await f.journal.update('automatic-target:'+JSON.stringify('project'),()=>({id:'legacy',boardId:'b',itemId:'task',target:'project'}));
 f.options.cleanup.mockRejectedValue(Object.assign(Error('missing association'),{code:'ASSOCIATION_UNKNOWN',cleanupPrecondition:true}));
 await automaticDelivery(f.options).scan();
 expect(f.run.mock.calls[0][1]).toMatchObject({itemId:'next',action:'build'});
 expect(await f.journal.get(storageKey)).toMatchObject({step:0,code:'ASSOCIATION_UNKNOWN',cleanupPrecondition:true,targetActions:f.options.policy.targetActions});
 expect(await f.journal.get('automatic-target:'+JSON.stringify('project'))).toMatchObject({itemId:'next'});
});
it('keeps a shared-target operation with an unknown receipt reserved',async()=>{
 const f=await fixture(),next={...f.item,id:'next'};f.board.items.push(next);f.options.target=()=> 'project';
 f.options.policy.targetActions=['build','deploy','accept','analyze','merge'];
 f.options.service.workflow=async()=>({dispatches:{a:{id:'d',itemId:'task',attempt:1,outcome:'succeeded'},b:{id:'next-run',itemId:'next',attempt:1,outcome:'succeeded'}}});
 await automaticDelivery(f.options).scan();f.jobs.get('build').state='unknown';
 await automaticDelivery(f.options).scan();await automaticDelivery(f.options).scan();
 expect(f.run.mock.calls.map(row=>row[1].itemId)).toEqual(['task']);
 expect(await f.journal.get('automatic-target:'+JSON.stringify('project'))).toMatchObject({itemId:'task'});
});
it('reclaims an inactive legacy finalizer only with plugin evidence and settled operation records',async()=>{
 const f=await fixture(),retired={...f.item,id:'retired',status:'completed'};f.board.items.unshift(retired);
 f.options.target=()=> 'project';f.options.automatic=async(_board,item)=>item.id!=='retired';
 const old={id:'retired-auto',boardId:'b',itemId:'retired',executionId:'retired',target:'project',step:0,steps:['cleanup'],cleanupPrecondition:true,requests:{}};
 await f.journal.update('automatic-delivery:'+JSON.stringify(['b','retired']),()=>old);
 await f.journal.update('automatic-target:'+JSON.stringify('project'),()=>({id:old.id,boardId:'b',itemId:'retired',target:'project'}));
 await f.journal.update('review-operations:'+JSON.stringify(['b','retired']),()=>({jobs:['pending']}));
 await f.journal.update('review-operation:pending',()=>({phase:'submitting'}));
 const proof=vi.fn(async()=>true);f.options.releasableTarget=proof;
 await automaticDelivery(f.options).scan();expect(f.run).not.toHaveBeenCalled();
 await f.journal.update('review-operation:pending',()=>({phase:'settled'}));
 await automaticDelivery(f.options).scan();expect(f.run.mock.calls[0][1]).toMatchObject({itemId:'task',action:'build'});
 expect(await f.journal.get('automatic-delivery:'+JSON.stringify(['b','retired']))).toEqual(old);
 expect(f.options.cleanup).not.toHaveBeenCalled();expect(proof).toHaveBeenCalled();
});

it('retains target ownership until cancelled work has no unsettled admitted operation',async()=>{
 const f=await fixture();f.options.target=()=> 'project';await automaticDelivery(f.options).scan();
 f.item.status='cancelled';f.board.items.push({...f.item,id:'second',status:'review'});
 f.options.service.workflow=async()=>({dispatches:{second:{id:'second',itemId:'second',attempt:1,outcome:'succeeded'}}});
 await f.journal.update('review-operations:'+JSON.stringify(['b','task']),()=>({jobs:['held']}));await f.journal.update('review-operation:held',()=>({phase:'submitting'}));
 await automaticDelivery(f.options).scan();expect(f.run).toHaveBeenCalledOnce();
 await f.journal.update('review-operation:held',()=>({phase:'settled'}));f.jobs.clear();await automaticDelivery(f.options).scan();
 expect(f.run).toHaveBeenCalledTimes(2);expect(f.run.mock.calls[1][1].itemId).toBe('second');
});
it('rechecks a cleanup precondition after restart without repeating unchanged notifications',async()=>{
 const f=await fixture();f.item.status='completed';(f.item.planning as any).execution='children';let blocked=true;
 f.options.cleanup=vi.fn(async()=>{if(blocked)throw Object.assign(new Error('Cache remains'),{code:'CACHE_PENDING',cleanupPrecondition:true});return true;});
 for(let n=0;n<3;n++)await automaticDelivery(f.options).scan();
 expect(f.options.cleanup).toHaveBeenCalledTimes(3);expect(f.options.report).toHaveBeenCalledOnce();expect(await automaticDelivery(f.options).ready('b',f.item as never)).toBe(false);
 blocked=false;await automaticDelivery(f.options).scan();expect(await automaticDelivery(f.options).ready('b',f.item as never)).toBe(true);
 expect(f.options.report).toHaveBeenLastCalledWith(expect.objectContaining({done:true,code:undefined}));
});
it('does not replay a cleanup effect whose outcome is unknown',async()=>{
 const f=await fixture();f.item.status='completed';(f.item.planning as any).execution='children';
 f.options.cleanup=vi.fn(async()=>{throw Object.assign(new Error('Unknown effect'),{code:'CLEANUP_OUTCOME_UNKNOWN'});});
 for(let n=0;n<3;n++)await automaticDelivery(f.options).scan();expect(f.options.cleanup).toHaveBeenCalledOnce();expect(f.options.report).toHaveBeenCalledOnce();
 expect(await automaticDelivery(f.options).ready('b',f.item as never)).toBe(false);
});

it('freezes selected steps across restarts and performs only one release for an entire chain',async()=>{
 const f=await fixture();f.options.plan=async()=>({steps:['accept','analyze','merge','cleanup']});
 await automaticDelivery(f.options).scan();f.options.plan=async()=>({steps:['build','deploy','accept','analyze','merge','cleanup']});
 for(let n=0;n<8;n++)await automaticDelivery(f.options).scan();
 expect(f.run.mock.calls.map(call=>call[1].action)).toEqual(['accept','analyze','merge']);expect(await automaticDelivery(f.options).ready('b',f.item as never)).toBe(true);
 f.jobs.clear();f.item.id='release';f.item.status='review';f.options.service.workflow=async()=>({dispatches:{r:{id:'r',itemId:'release',attempt:1,outcome:'succeeded'}}});
 for(let n=0;n<12;n++)await automaticDelivery(f.options).scan();
 f.jobs.clear();f.item.id='verifier';f.item.status='review';f.options.plan=async()=>({steps:['accept','cleanup']});
 f.options.service.workflow=async()=>({dispatches:{v:{id:'v',itemId:'verifier',attempt:1,outcome:'succeeded'}}});
 for(let n=0;n<4;n++)await automaticDelivery(f.options).scan();
 const actions=f.run.mock.calls.map(call=>call[1].action);expect(actions.filter(action=>action==='build')).toHaveLength(1);expect(actions.filter(action=>action==='deploy')).toHaveLength(1);
 expect(actions.at(-1)).toBe('accept');expect(f.options.cleanup).toHaveBeenCalledTimes(3);
});
it('rechecks pause after asynchronous preparation before admitting the next step',async()=>{
 const f=await fixture(),view=f.options.view;
 f.options.view=async()=>{const result=await view();(f.board as any).executionControl={paused:true};return result;};
 await automaticDelivery(f.options).scan();expect(f.run).not.toHaveBeenCalled();expect(f.options.report).not.toHaveBeenCalled();
 (f.board as any).executionControl={paused:false};f.options.view=view;await automaticDelivery(f.options).scan();expect(f.run).toHaveBeenCalledOnce();
});
it('builds once then waits for manual receipts across restarts without deploy, merge or premature cleanup',async()=>{
 const f=await fixture();f.options.plan=async()=>({steps:['build','deploy','analyze','merge','accept','cleanup'],manualAfter:'build'});f.options.target=()=> 'project';
 for(let n=0;n<6;n++)await automaticDelivery(f.options).scan();
 expect(f.run.mock.calls.map(call=>call[1].action)).toEqual(['build']);expect(f.options.cleanup).not.toHaveBeenCalled();
 expect(await automaticDelivery(f.options).ready('b',f.item as never)).toBe(false);
 expect(f.options.report).toHaveBeenCalledOnce();expect(f.options.report).toHaveBeenCalledWith(expect.objectContaining({waitingForUser:true}));
 expect(await f.journal.get('automatic-target:'+JSON.stringify('project'))).toBeNull();
 for(const action of ['deploy','accept','analyze','merge']){f.jobs.set(action,{id:action,runId:'human-'+action,state:'succeeded',enabled:true});await automaticDelivery(f.options).scan();}
 f.item.status='completed';await automaticDelivery(f.options).scan();expect(f.options.cleanup).toHaveBeenCalledOnce();
 expect(await automaticDelivery(f.options).ready('b',f.item as never)).toBe(true);expect(f.run).toHaveBeenCalledOnce();
});
it('retries only a proven unadmitted precondition with a new frozen identity and preserves the old request',async()=>{
 const f=await fixture();f.options.plan=async()=>({steps:['accept','cleanup']});
 const original=f.options.run;f.options.run=vi.fn(async()=>{throw Object.assign(Error('version changed'),{code:'OPERATION_RUNNING_VERSION_MISMATCH'});});
 await automaticDelivery(f.options).scan();const old=f.options.run.mock.calls[0][1];
 await automaticDelivery(f.options).scan();expect(f.options.run).toHaveBeenCalledOnce();
 f.options.retryPrecondition=async()=>true;f.options.view=async()=>({revision:'new-revision',operations:[{id:'accept',enabled:true,state:'ready'}]});f.options.run=original;
 await automaticDelivery(f.options).scan();
 const retried=f.run.mock.calls[0][1];expect(retried.operationId).not.toBe(old.operationId);expect(retried.expectedRevision).toBe('new-revision');
 expect(await f.journal.get('automatic-precondition-retry:'+old.operationId)).toEqual(old);
});
it('advances explicitly waived steps without running or cleaning them and preserves independent operations',async()=>{
 const f=await fixture(),base=f.options.view;
 f.options.view=async()=>{const view=await base();return {...view,skippedActions:['build','deploy','accept','merge','cleanup'],operations:view.operations.map(row=>['build','deploy','accept','merge'].includes(row.id)?{...row,state:'skipped',enabled:false}:row)};};
 for(let n=0;n<10;n++)await automaticDelivery(f.options).scan();
 expect(f.run.mock.calls.map(call=>call[1].action)).toEqual(['analyze']);expect(f.options.cleanup).not.toHaveBeenCalled();
 expect(await automaticDelivery(f.options).ready('b',f.item as never)).toBe(true);
});
it('holds automatic follow-up during cancellation and only resumes after an explicit new build',async()=>{
 const f=await fixture(),view=f.options.view;let halted:{runId:string;state:string}|undefined={runId:'cancelled-build',state:'cancelling'};
 f.options.view=async()=>({...await view(),halted});
 await automaticDelivery(f.options).scan();expect(f.run).not.toHaveBeenCalled();
 halted={...halted!,state:'cancelled'};await automaticDelivery(f.options).scan();await automaticDelivery(f.options).scan();
 expect(f.run).not.toHaveBeenCalled();expect(f.options.cleanup).not.toHaveBeenCalled();expect(await automaticDelivery(f.options).ready('b',f.item as never)).toBe(false);
 halted=undefined;f.jobs.set('build',{id:'build',runId:'explicit-new-build',state:'succeeded',enabled:true});await automaticDelivery(f.options).scan();
 expect(f.run.mock.calls.map(row=>row[1].action)).toEqual(['deploy']);
});

it('migrates the order of a frozen plan while preserving request identities and unknown work',async()=>{
 const f=await fixture();await automaticDelivery(f.options).scan();
 const key='automatic-delivery:'+JSON.stringify(['b','task']);
 const original={operationId:'original-analysis',itemId:'task',action:'analyze',expectedRevision:'original'};
 await f.journal.update<any>(key,old=>({...old,step:2,steps:['build','deploy','analyze','merge','accept','cleanup'],requests:{...old.requests,analyze:original}}));
 f.jobs.set('deploy',{id:'deploy',state:'succeeded',runId:'original-deploy'});
 f.jobs.set('accept',{id:'accept',state:'unavailable',enabled:false});
 f.jobs.set('analyze',{id:'analyze',state:'unknown',enabled:false,runId:'original-analysis'});
 for(let n=0;n<6;n++)await automaticDelivery(f.options).scan();
 expect(f.run).toHaveBeenCalledOnce();expect(f.options.cleanup).not.toHaveBeenCalled();
 expect(await f.journal.get(key)).toMatchObject({step:2,steps:['build','deploy','accept','analyze','merge','cleanup'],requests:{analyze:original}});
});
it('resumes automatic submission after an acceptance-only waiver without waiving merge or cleanup',async()=>{
 const f=await fixture(),base=f.options.view;
 f.options.view=async()=>{const view=await base();return {...view,skippedActions:['accept'],
  operations:view.operations.map(row=>row.id==='accept'?{...row,state:'skipped',enabled:false}:row)};};
 for(let n=0;n<14;n++)await automaticDelivery(f.options).scan();
 expect(f.run.mock.calls.map(call=>call[1].action)).toEqual(['build','deploy','analyze','merge']);
 expect(f.options.cleanup).toHaveBeenCalledOnce();expect(await automaticDelivery(f.options).ready('b',f.item as never)).toBe(true);
 await automaticDelivery(f.options).scan();expect(f.run).toHaveBeenCalledTimes(4);
});

it('automatically integrates a conflict-free repository scope and keeps its receipts independent',async()=>{
 const f=await fixture();f.item.status='completed';(f.item.planning as any).execution='children';
 f.options.service.workflow=async()=>({dispatches:{}});
 const scoped={...f.options,scopeId:'repo-a',plan:async()=>({ordering:'configured',steps:['analyze','merge','accept','cleanup']})};
 for(let n=0;n<10;n++)await automaticDelivery(scoped).scanScope('b','task');
 expect(f.run.mock.calls.map(call=>call[1].action)).toEqual(['analyze','merge','accept']);
 expect(f.run.mock.calls.every(call=>call[1].scopeId==='repo-a'&&call[1].confirmed===undefined)).toBe(true);
 expect(await f.journal.get('automatic-delivery:'+JSON.stringify(['b','task','repo-a']))).toMatchObject({step:4});
 expect(await f.journal.get('automatic-delivery:'+JSON.stringify(['b','task','repo-b']))).toBeUndefined();
 expect(f.options.cleanup).toHaveBeenCalledOnce();
});
it('hands off source acceptance without pretending the old integration and cleanup stages ran',async()=>{
 const f=await fixture();f.options.handoff=async()=>({boardId:'b',itemId:'management'});
 f.options.settle=async()=>{if(f.jobs.has('accept'))f.item.status='completed';};
 await automaticDelivery(f.options).scan();await automaticDelivery(f.options).scan();
 expect(f.run.mock.calls.map(call=>call[1].action)).toEqual(['accept']);expect(f.options.cleanup).not.toHaveBeenCalled();
 const state=await f.journal.get<any>('automatic-delivery:'+JSON.stringify(['b','task']));
 expect(state).toMatchObject({handoff:{boardId:'b',itemId:'management'},step:0});expect(state.done).toBeUndefined();
 expect(await f.journal.get('automatic-handoff-history:'+state.id)).toMatchObject({step:0});
 expect(await automaticDelivery(f.options).ready('b',f.item as never)).toBe(true);
});

it('does not integrate an old checkpoint ahead of a newly projected build-only manual boundary',async()=>{
 const f=await fixture();const scope={...f.options,scopeId:'build-only',plan:async()=>({ordering:'configured',steps:['build','analyze','merge','accept','cleanup'],manualAfter:'build'})};
 (f.item.planning as any).execution='children';f.item.status='completed';f.options.service.workflow=async()=>({dispatches:{}});
 const key='automatic-delivery:'+JSON.stringify(['b','task','build-only']);
 await automaticDelivery(scope).scanScope('b','task');
 expect(f.run.mock.calls.map(call=>call[1].action)).toEqual(['build']);
 await f.journal.update<any>(key,old=>({...old,steps:['analyze','merge','build','accept','cleanup'],step:1}));
 for(let attempt=0;attempt<3;attempt++)await automaticDelivery(scope).scanScope('b','task');
 expect(f.run.mock.calls.some(call=>call[1].action==='merge')).toBe(false);
 expect(await f.journal.get(key)).toMatchObject({reportedBoundary:'merge'});
});

it('derives completion and authority waiting from the cursor instead of legacy flags',async()=>{
 const {automaticDeliveryStatus}=await import('../src/runtime/automatic-delivery');
 const f=await fixture(),key='automatic-delivery:'+JSON.stringify(['b','task']);
 await automaticDelivery(f.options).scan();
 await f.journal.update<any>(key,old=>({...old,steps:['analyze','merge'],step:1,manualAfter:'analyze',manualOrder:['analyze','merge'],waitingForUser:false}));
 expect(await automaticDeliveryStatus(f.journal,'b','task',undefined,f.options.policy.steps)).toMatchObject({state:'waiting-confirmation',attention:{kind:'authorization'}});
 await f.journal.update<any>(key,old=>({...old,step:2,waitingForUser:true,done:false}));
 expect(await automaticDeliveryStatus(f.journal,'b','task',undefined,f.options.policy.steps)).toMatchObject({state:'completed',waitingForUser:false});
});
it('does not persist derived completion and confirmation flags in new checkpoints',async()=>{
 const f=await fixture();for(let n=0;n<12;n++)await automaticDelivery(f.options).scan();
 const state=await f.journal.get<any>('automatic-delivery:'+JSON.stringify(['b','task']));
 expect(state).toMatchObject({step:6});expect(state).not.toHaveProperty('done');expect(state).not.toHaveProperty('waitingForUser');
 expect(f.run.mock.calls.every(([,request])=>request.confirmed===undefined)).toBe(true);
});
