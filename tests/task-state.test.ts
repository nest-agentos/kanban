import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule, SeqKanbanStore, projectKanbanTask, taskStartAt} from '../src';
import {createKanbanExecutionBridge} from '../src/execution';
import type {KanbanCommand, KanbanService, KanbanItem, KanbanBoard} from '../src/contracts';

const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();vi.restoreAllMocks();});
async function fixture(policy: Partial<KanbanBoard['policy']> = {}) {
    let now=1000000,seq=0;vi.spyOn(Date,'now').mockImplementation(()=>now);
    const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());
    const fs=await manager.openFileSystem('/'),store=await SeqKanbanStore.open(fs);
    const api=(id:string)=>createKanbanModule({store,actor:{kind:'service',id},authorize:async()=>{},now:()=>now,log(){}});
    const service=api('manager'),worker=api('worker');
    await service.create({id:'board',title:'Work',scope:{kind:'system'},policy:{requireEstimate:false,review:'independent',...policy},members:[{kind:'service',id:'manager',roles:['coordinator','reviewer'],responsibility:'Manage'},{kind:'service',id:'worker',roles:['worker'],responsibility:'Build'}]});
    const run=async(command:KanbanCommand,client:KanbanService=service)=>client.execute('board',{operationId:'op-'+ ++seq,expectedRevision:(await client.read('board')).revision,command});
    await run({type:'publish-plan',plan:{schema:'kanban.plan/1',id:'plan',revision:1,sealed:true,items:[{id:'task',title:'Task',responsibility:'Build',acceptance:'Verify',assignee:{kind:'service',id:'worker'},dependsOn:[]}]}});
    const executor={prepare:vi.fn(async()=>({id:'original'})),start:vi.fn(async()=>({outcome:'running' as const,executionSessionId:'original-session'})),inspect:vi.fn(async()=>({outcome:'running' as const,executionSessionId:'original-session'}))};
    const bridge=async()=>{const b=await createKanbanExecutionBridge({fs,directory:'/executions',boardId:'board',service,worker:async()=>worker,autoDispatch:true,executor,authorize:async()=>{},log(){}});closes.push(()=>b.quiesce());return b;};
    const human=createKanbanModule({store,actor:{kind:"human",id:"admin"},restartReferences:refs=>refs.filter(ref=>ref.system==='project'),authorize:async()=>{},now:()=>now,log(){}});
    return {store,service,api,human,run,bridge,executor,clock:(elapsed:number)=>{now=1000000+elapsed;},item:async()=>(await service.item('board','task')).item};
}
it('persists the five-minute deadline and admits exactly once at 300000ms across competing/restarted bridges',async()=>{
    const f=await fixture(),first=await f.bridge(),second=await f.bridge();
    const original=await f.item();expect(original.launch?.startAt).toBe(original.createdAt+300000);
    await first.scan();f.clock(299999);await second.scan();expect(f.executor.start).not.toHaveBeenCalled();
    f.clock(300000);await Promise.all([first.scan(),second.scan()]);expect(f.executor.start).toHaveBeenCalledTimes(1);
    await first.quiesce();await second.quiesce();const recovered=await f.bridge();await recovered.scan();
    expect(f.executor.start).toHaveBeenCalledTimes(1);expect(Object.values((await f.service.workflow('board')).dispatches)).toHaveLength(1);
    expect((await f.item()).launch?.startAt).toBe(original.launch?.startAt);
    expect((await f.service.query('board',{view:'all'})).items[0].task).toMatchObject({phase:'running',sessionId:'original-session'});
});
it('serializes immediate run and timer admission without another primary Session',async()=>{
    const f=await fixture(),a=await f.bridge(),b=await f.bridge();f.clock(300000);
    await f.run({type:'request-run',itemId:'task'});await Promise.all([a.scan(),b.scan()]);
    expect(f.executor.start).toHaveBeenCalledTimes(1);expect(Object.values((await f.service.workflow('board')).dispatches)).toHaveLength(1);
});
it('arbitrates editing on the server, preserves deadlines and waits until save/cancel or lease expiry',async()=>{
    const f=await fixture(),b=await f.bridge(),original=await f.item();
    f.clock(299999);await f.run({type:'begin-edit',itemId:'task',editId:'edit',leaseMs:300000});
    await expect(f.run({type:'request-run',itemId:'task'})).rejects.toMatchObject({code:'EDIT_LEASE_ACTIVE'});
    await expect(f.run({type:'begin-edit',itemId:'task',editId:'other-client',leaseMs:300000},f.api('other'))).rejects.toMatchObject({code:'EDIT_LEASE_ACTIVE'});
    f.clock(300000);await b.scan();expect(f.executor.start).not.toHaveBeenCalled();
    await f.run({type:'save-edit',itemId:'task',editId:'edit',title:'Reviewed',responsibility:'Reviewed build',acceptance:'Reviewed evidence',planning:original.planning!});
    expect((await f.item()).createdAt).toBe(original.createdAt);expect((await f.item()).launch?.startAt).toBe(original.launch?.startAt);
    await b.scan();expect(f.executor.start).toHaveBeenCalledTimes(1);
    await expect(f.run({type:'begin-edit',itemId:'task',editId:'late',leaseMs:1000})).rejects.toMatchObject({code:'TASK_DEFINITION_FROZEN'});
    await expect(f.run({type:'edit-item',itemId:'task',title:'Late',responsibility:'Late',acceptance:'Late'})).rejects.toBeDefined();
});
it('rechecks a disconnected editor lease after restart without moving startAt',async()=>{
    const f=await fixture();await f.run({type:'begin-edit',itemId:'task',editId:'gone',leaseMs:300000});f.clock(300000);
    const b=await f.bridge();await b.scan();expect(f.executor.start).toHaveBeenCalledTimes(1);
});
it('does not let automatic triggers bypass a task pause and resumes the same waiting task',async()=>{
    const f=await fixture(),b=await f.bridge();await f.run({type:'request-control',itemId:'task',controlId:'pause',action:'pause'});
    await f.run({type:'control-receipt',itemId:'task',controlId:'pause',state:'paused'});f.clock(300000);await b.scan();expect(f.executor.start).not.toHaveBeenCalled();
    await f.run({type:'request-control',itemId:'task',controlId:'resume',action:'resume'});await f.run({type:'control-receipt',itemId:'task',controlId:'resume',state:'resumed'});
    await b.scan();expect(f.executor.start).toHaveBeenCalledTimes(1);
});
it('requires independent acceptance and never offers or permits run after completion',async()=>{
    const f=await fixture();await f.run({type:'request-run',itemId:'task'});const b=await f.bridge();await b.scan();
    const dispatch=Object.values((await f.service.workflow('board')).dispatches)[0];
    await f.run({type:'observe-execution',dispatchId:dispatch.id,fence:dispatch.fence,outcome:'succeeded'});
    expect((await f.item()).status).toBe('review');expect((await f.service.query('board',{view:'all',phase:'review'})).total).toBe(1);
    await f.run({type:'accept-execution',dispatchId:dispatch.id,accept:true});
    await expect(f.run({type:'request-run',itemId:'task'})).rejects.toMatchObject({code:'TASK_DEFINITION_FROZEN'});
    expect(projectKanbanTask(await f.item(),await f.service.workflow('board')).actions).not.toContain('run');
});
it('projects unresolved issues, concrete analysis errors and observation unknown without treating Session idle as completion',async()=>{
    const f=await fixture(),item=await f.item();
    expect(taskStartAt({...item,launch:undefined})).toBe(item.createdAt+300000);
    const phase=(patch:Partial<KanbanItem>)=>projectKanbanTask({...item,...patch},undefined,1000000).phase;
    expect(phase({analysis:{itemId:'task',state:'failed',code:'EFFECT_TIMEOUT'}})).toBe('error');
    expect(phase({analysis:{itemId:'task',state:'analyzing'}})).toBe('analyzing');
    expect(phase({analysis:{itemId:'task',state:'unknown'}})).toBe('unknown');
    expect(phase({issues:[{id:'q',attemptId:'a',type:'clarification'}]})).toBe('waiting-input');
    expect(phase({issues:[{id:'q',attemptId:'a',type:'clarification',resolvedBy:'resolved'}]})).toBe('waiting-start');
    expect(projectKanbanTask({...item,planning:{...item.planning!,dependencies:['cancelled']}},undefined,1000000,[{id:'cancelled',status:'cancelled'}])).toMatchObject({phase:'waiting-dependency',reason:'DEPENDENCY_UNFINISHED:cancelled'});
});

it('persists legacy deadlines from the original creation time during the shared startup scan',async()=>{
    const f=await fixture(),before=await f.item();
    await f.store.update('board','legacy-test','legacy-test',state=>{delete state!.board.items[0].launch;return state!;});
    await f.service.scan();const restored=await f.item();
    expect(restored.createdAt).toBe(before.createdAt);expect(restored.launch?.startAt).toBe(before.createdAt+300000);
    expect((await f.service.events('board')).filter(e=>e.kind==='task-launch-initialized')).toHaveLength(1);
    await f.service.scan();expect((await f.service.events('board')).filter(e=>e.kind==='task-launch-initialized')).toHaveLength(1);
});
it('keeps manual tasks idle beyond the deadline and starts only after explicit run', async () => {
    const f = await fixture(), bridge = await f.bridge(); await f.run({type: 'set-launch-mode', itemId: 'task', mode: 'manual'});
    f.clock(900000); await bridge.scan(); expect(f.executor.start).not.toHaveBeenCalled();
    expect((await f.service.item('board', 'task')).task).toMatchObject({phase: 'waiting-start', reason: 'MANUAL_START_REQUIRED'});
    await f.run({type: 'request-run', itemId: 'task'}); await bridge.scan(); await bridge.scan();
    expect(f.executor.start).toHaveBeenCalledTimes(1);
    await expect(f.run({type: 'set-launch-mode', itemId: 'task', mode: 'automatic'})).rejects.toMatchObject({code: 'TASK_DEFINITION_FROZEN'});
});
it('creates a manual task already paused, without a gap for automatic admission', async () => {
    const f = await fixture();
    await f.run({type: 'create-item', item: {id: 'held', title: 'Deferred analysis', responsibility: 'Wait', acceptance: 'Explicit user resume'}, launch: {mode: 'manual', paused: true}});
    let item = await f.service.item('board', 'held'); expect(item.item.launch?.mode).toBe('manual'); expect(item.task?.phase).toBe('paused');
    await f.run({type: 'request-control', itemId: 'held', controlId: 'resume-held', action: 'resume'});
    await f.run({type: 'control-receipt', itemId: 'held', controlId: 'resume-held', state: 'resumed'});
    f.clock(900000); item = await f.service.item('board', 'held'); expect(item.task).toMatchObject({phase: 'waiting-start', reason: 'MANUAL_START_REQUIRED'});
    expect(f.executor.start).not.toHaveBeenCalled();
});

it('persists manual board admission across bridge restart and honors only explicit run requests', async () => {
    const f = await fixture();
    await expect(f.run({type:'set-board-control',mode:'manual'})).rejects.toMatchObject({code:'FORBIDDEN'});
    await f.run({type:'set-board-control',mode:'manual'}, f.human);
    f.clock(900000); const first=await f.bridge(); await first.scan(); expect(f.executor.start).not.toHaveBeenCalled();
    await first.quiesce(); const recovered=await f.bridge(); await recovered.scan(); expect(f.executor.start).not.toHaveBeenCalled();
    await f.run({type:'request-run',itemId:'task'}); await recovered.scan(); expect(f.executor.start).toHaveBeenCalledTimes(1);
});
it('commits a scheduling barrier, waits for original control receipts and resumes only board-owned pauses', async () => {
    const f=await fixture(), bridge=await f.bridge(); f.clock(300000); await bridge.scan();
    await f.run({type:'set-board-control',paused:true},f.human);
    expect((await f.service.catalog())[0].executionPhase).toBe('pausing');
    const control=(await f.item()).control!;
    await expect(f.run({type:'set-board-control',paused:false},f.human)).rejects.toMatchObject({code:'CONTROL_UNSETTLED'});
    await f.run({type:'control-receipt',itemId:'task',controlId:control.id,state:'paused'});
    expect((await f.service.catalog())[0].executionPhase).toBe('paused');
    await f.run({type:'set-board-control',paused:false},f.human);
    expect((await f.service.catalog())[0].executionPhase).toBe('resuming');
    const resumed=(await f.item()).control!;
    await f.run({type:'control-receipt',itemId:'task',controlId:resumed.id,state:'resumed'});
    expect((await f.service.catalog())[0].executionPhase).toBe('automatic');
    expect(f.executor.start).toHaveBeenCalledTimes(1);
});
it('preserves individual holds and prevents fresh work from starting while the board is paused', async () => {
    const f=await fixture();
    await f.run({type:'request-control',itemId:'task',controlId:'individual',action:'pause'});
    await f.run({type:'control-receipt',itemId:'task',controlId:'individual',state:'paused'});
    await f.run({type:'set-board-control',paused:true},f.human); f.clock(900000);
    const bridge=await f.bridge(); await bridge.scan(); expect(f.executor.start).not.toHaveBeenCalled();
    await f.run({type:'set-board-control',paused:false},f.human);
    expect((await f.item()).control).toMatchObject({id:'individual',action:'pause',state:'paused'});
    await bridge.scan(); expect(f.executor.start).not.toHaveBeenCalled();
});
it('reports unsupported execution controls as errors instead of claiming the execution paused', async () => {
    const f=await fixture(),bridge=await f.bridge();f.clock(300000);await bridge.scan();
    await f.run({type:'set-board-control',paused:true},f.human);
    const control=(await f.item()).control!;
    await f.run({type:'control-receipt',itemId:'task',controlId:control.id,state:'failed',code:'TASK_CONTROL_UNSUPPORTED'});
    expect((await f.service.catalog())[0].executionPhase).toBe('error');
});

it('explicitly reopens a cancelled unstarted task into manual backlog and preserves its cancellation audit', async () => {
    const f = await fixture();
    await f.run({type: 'create-item', item: {id: 'unstarted', title: 'Retry', responsibility: 'Inspect', acceptance: 'Evidence'}});
    await f.run({type: 'request-control', itemId: 'unstarted', controlId: 'cancel-before-start', action: 'cancel'});
    await f.run({type: 'control-receipt', itemId: 'unstarted', controlId: 'cancel-before-start', state: 'cancelled'});
    await expect(f.run({type: 'reopen-item', itemId: 'unstarted', reopenId: 'retry'}, f.service)).rejects.toMatchObject({code: 'FORBIDDEN'});
    const request = {operationId: 'recover-original', expectedRevision: (await f.human.read('board')).revision,
        command: {type: 'reopen-item' as const, itemId: 'unstarted', reopenId: 'retry'}};
    await f.human.execute('board', request); await f.human.execute('board', request);
    const result = await f.human.item('board', 'unstarted');
    expect(result.item).toMatchObject({id: 'unstarted', status: 'backlog', launch: {mode: 'manual', analysisEpoch: 'retry'}});
    expect(result.item.control).toBeUndefined(); expect(result.item.closedAt).toBeUndefined();
    expect(result.task).toMatchObject({phase: 'waiting-start'});
    const events = await f.human.events('board');
    expect(events.filter(event => event.kind === 'reopen-item')).toHaveLength(1);
    expect(events.some(event => event.kind === 'control-receipt' && event.itemId === 'unstarted')).toBe(true);
});
it('refuses reopening a cancelled task which already belongs to an execution plan', async () => {
    const f = await fixture();
    await f.run({type: 'request-control', itemId: 'task', controlId: 'cancel-planned', action: 'cancel'});
    await f.run({type: 'control-receipt', itemId: 'task', controlId: 'cancel-planned', state: 'cancelled'});
    await expect(f.run({type: 'reopen-item', itemId: 'task', reopenId: 'unsafe'}, f.human)).rejects.toThrow();
    expect((await f.item()).status).toBe('cancelled'); expect(f.executor.start).not.toHaveBeenCalled();
});

it('restarts cancelled planned work as a fresh linked task without reusing its sealed plan', async () => {
    const f = await fixture();
    await expect(f.run({type:'restart-item',itemId:'task',replacementId:'fresh'},f.human)).rejects.toMatchObject({code:'TASK_NOT_CANCELLED'});
    await f.run({type:'link-reference',itemId:'task',reference:{system:'project',id:'remote'}});
    await f.run({type:'link-reference',itemId:'task',reference:{system:'worktree',id:'old-tree'}});
    await f.run({type:'request-control',itemId:'task',controlId:'stop',action:'cancel'});
    await f.run({type:'control-receipt',itemId:'task',controlId:'stop',state:'cancelled'});
    await expect(f.run({type:'restart-item',itemId:'task',replacementId:'fresh'},f.service)).rejects.toMatchObject({code:'FORBIDDEN'});
    await f.run({type:'restart-item',itemId:'task',replacementId:'fresh'},f.human);
    const original = (await f.human.item('board','task')).item, next = (await f.human.item('board','fresh')).item;
    expect(original.status).toBe('cancelled');
    expect(original.externalRefs).toHaveLength(2);
    expect(next.externalRefs).toEqual([{system:'project',id:'remote'}]);
    expect(next).toMatchObject({id:'fresh',title:original.title,responsibility:original.responsibility,acceptance:original.acceptance,restartedFrom:'task',status:'backlog',launch:{mode:'manual'}});
    expect(next.owner).toBeUndefined(); expect(next.analysis).toBeUndefined(); expect(next.control).toBeUndefined(); expect(next.participants).toEqual([]);
    expect(Object.values((await f.human.workflow('board')).plans).every(plan=>!plan.itemIds.includes('fresh'))).toBe(true);
    await expect(f.run({type:'restart-item',itemId:'task',replacementId:'fresh'},f.human)).rejects.toMatchObject({code:'ITEM_EXISTS'});
});

it('allocates readable task IDs transactionally while numbering custom IDs independently', async () => {
    const f = await fixture();
    const request = {operationId:'auto-create',expectedRevision:(await f.human.read('board')).revision,
        command:{type:'create-item' as const,item:{title:'Auto task',responsibility:'Build',acceptance:'Verify'}}};
    const first = await f.human.execute('board',request), item = first.items.find(item=>item.title==='Auto task')!;
    expect(item.id).toBe('task-002'); expect(item.number).toBe(2);
    expect(await f.human.execute('board',request)).toEqual(first);
    await f.run({type:'create-item',item:{id:'meaningful-name',title:'Named task',responsibility:'Build',acceptance:'Verify'}},f.human);
    expect((await f.human.item('board','meaningful-name')).item.number).toBe(3);
    await expect(f.run({type:'create-item',item:{id:'meaningful-name',title:'Duplicate',responsibility:'Build',acceptance:'Verify'}},f.human)).rejects.toMatchObject({code:'ITEM_EXISTS'});
});

it.each([
    [{}, true],
    [{maxInProgressPerAssignee: 1}, false],
    [{maxInProgressPerAgent: 1}, false],
    [{maxInProgress: 1}, false],
] as const)('separates default execution capacity from explicit review WIP: %j', async (policy, starts) => {
    const f = await fixture(policy);
    await f.run({type: 'request-run', itemId: 'task'});
    const bridge = await f.bridge(); await bridge.scan();
    const dispatch = Object.values((await f.service.workflow('board')).dispatches)[0];
    await f.run({type: 'observe-execution', dispatchId: dispatch.id, fence: dispatch.fence, outcome: 'succeeded'});
    await f.run({type: 'publish-plan', plan: {schema: 'kanban.plan/1', id: 'next-plan', revision: 1, sealed: true,
        items: [{id: 'next', title: 'Next', responsibility: 'Build', acceptance: 'Verify', assignee: {kind: 'service', id: 'worker'}, dependsOn: []}]}});
    await f.run({type: 'request-run', itemId: 'next'}); await bridge.scan();
    expect(f.executor.start).toHaveBeenCalledTimes(starts ? 2 : 1);
    expect((await f.item()).status).toBe('review');
});
it('keeps active executions within the default per-assignee capacity', async () => {
    const f = await fixture(); await f.run({type: 'request-run', itemId: 'task'});
    const bridge = await f.bridge(); await bridge.scan();
    await f.run({type: 'publish-plan', plan: {schema: 'kanban.plan/1', id: 'next-plan', revision: 1, sealed: true,
        items: [{id: 'next', title: 'Next', responsibility: 'Build', acceptance: 'Verify', assignee: {kind: 'service', id: 'worker'}, dependsOn: []}]}});
    await f.run({type: 'request-run', itemId: 'next'}); await bridge.scan();
    expect(f.executor.start).toHaveBeenCalledTimes(1);
});
it('projects task groups from child states and never offers an independent execution',()=>{
    const group={id:'group',status:'backlog',createdAt:1,launch:{startAt:10000,admittedAt:1},planning:{kind:'task',execution:'children',priority:2,dependencies:[],references:[]}} as KanbanItem;
    const child={id:'child',status:'backlog',createdAt:1,launch:{startAt:10000},planning:{kind:'subtask',parentId:'group',priority:2,dependencies:[],references:[]}} as KanbanItem;
    const project=(item:KanbanItem)=>projectKanbanTask(group,undefined,100,[group,item]);
    expect(project({...child,issues:[{id:'q',attemptId:'a',type:'clarification'}]})).toMatchObject({phase:'waiting-input',reason:'GROUP_INPUT_REQUIRED'});
    expect(project({...child,status:'review'})).toMatchObject({phase:'review',reason:'GROUP_CHILD_REVIEW'});
    expect(project({...child,status:'claimed'})).toMatchObject({phase:'running',reason:'GROUP_CHILD_RUNNING'});
    expect(project({...child,status:'completed'})).toMatchObject({phase:'waiting-dependency',reason:'GROUP_SETTLEMENT_PENDING'});
    expect(project({...child,status:'cancelled'})).toMatchObject({phase:'error',reason:'GROUP_CHILD_CANCELLED'});
    expect(project(child).actions).toEqual(['cancel']);
    expect(project(child).sessionId).toBeUndefined();
});
it('returns current parent state and complete child totals with a child page',async()=>{
    const f=await fixture();await f.run({type:'create-item',item:{id:'group',title:'Group',responsibility:'Scope',acceptance:'All accepted'}});
    await f.run({type:'create-item',item:{id:'child',title:'Child',responsibility:'Work',acceptance:'Verified'},planning:{kind:'subtask',parentId:'group',priority:2,dependencies:[],references:[]}});
    await f.run({type:'report-analysis',itemId:'child',operationId:'planning',status:{itemId:'child',state:'clarification',reason:'Clarify'}});
    const waiting=await f.service.query('board',{view:'all',parentId:'group',limit:1});
    expect(waiting.progress).toMatchObject({total:1,waitingInput:1,completed:0});expect(waiting.parentTask?.phase).toBe('waiting-input');
    await f.run({type:'report-analysis',itemId:'child',operationId:'planning-error',status:{itemId:'child',state:'failed',code:'EIO'}});
    const failed=await f.service.query('board',{view:'all',parentId:'group',limit:1});
    expect(failed.progress?.errors).toBe(1);expect(failed.parentTask).toMatchObject({phase:'error',reason:'GROUP_CHILD_ERROR'});
});
