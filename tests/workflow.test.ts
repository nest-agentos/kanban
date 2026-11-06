import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {SeqKanbanStore, createKanbanModule, type KanbanWorkPlan, type KanbanCommand, type KanbanModuleHandle} from '../src';
const closes: Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0)) await close();});
async function fixture() {
    const backend=new MemoryBackend(),{manager}=await createVFS({rootBackend:backend});closes.push(()=>manager.dispose());
    const fs=await manager.openFileSystem('/'),store=await SeqKanbanStore.open(fs);
    const log=vi.fn(), verifyOutputs=vi.fn(async (_input: unknown)=>true); const api=(id:string)=>createKanbanModule({store,actor:{kind:'service',id},authorize:async()=>{},verifyOutputs,log});
    const managerApi=api('manager'),worker=api('worker');
    await managerApi.create({id:'b',title:'Work',scope:{kind:'system'},members:[{kind:'service',id:'manager',responsibility:'Manage',roles:['coordinator','reviewer']},{kind:'service',id:'worker',responsibility:'Build',roles:['worker']},{kind:'human',id:'reviewer',responsibility:'Review',roles:['reviewer']},{kind:'service',id:'other-manager',responsibility:'Other',roles:['coordinator']}],policy:{requireEstimate:false,review:'independent'}});
    let serial=0;
    const run=async(service:KanbanModuleHandle,command:KanbanCommand)=>service.execute('b',{operationId:`op-${++serial}`,expectedRevision:(await service.read('b')).revision,command});
    const plan:KanbanWorkPlan={schema:'kanban.plan/1',id:'plan',revision:1,sealed:true,items:[
        {id:'api',title:'Implement',responsibility:'Implement the contract',acceptance:'Tests pass',assignee:{kind:'service',id:'worker'},dependsOn:['schema'],inputs:{schema:{fromItemId:'schema',output:'schema'}}},
        {id:'schema',title:'Contract',responsibility:'Define contract',acceptance:'Reviewed',assignee:{kind:'service',id:'worker'},dependsOn:[],outputs:['schema']},
    ]};
    return {fs,store,api,managerApi,worker,run,plan,log,backend,verifyOutputs};
}
it('publishes an unordered DAG atomically, pins inputs and advances only after independent acceptance',async()=>{
    const f=await fixture();await f.run(f.managerApi,{type:'publish-plan',plan:f.plan});
    expect((await f.managerApi.workflow('b')).ready).toEqual(['schema']);
    await f.run(f.worker,{type:'prepare-dispatch',itemId:'schema',dispatchId:'d1'});
    const dispatch=(await f.managerApi.workflow('b')).dispatches.d1;
    const output={name:'schema',ref:'artifact:one',sha256:'a'.repeat(64),bytes:10};
    await f.run(f.managerApi,{type:'observe-execution',dispatchId:'d1',fence:dispatch.fence,outcome:'succeeded',outputs:[output]});
    expect((await f.managerApi.workflow('b')).ready).toEqual([]);
    await f.run(f.managerApi,{type:'accept-execution',dispatchId:'d1',accept:true});
    expect((await f.managerApi.workflow('b')).ready).toEqual(['api']);
    await f.run(f.worker,{type:'prepare-dispatch',itemId:'api',dispatchId:'d2'});
    const next=(await f.managerApi.workflow('b')).dispatches.d2;expect(next.inputs.schema).toEqual(output);
    await f.run(f.managerApi,{type:'observe-execution',dispatchId:'d2',fence:next.fence,outcome:'succeeded'});
    await f.run(f.managerApi,{type:'accept-execution',dispatchId:'d2',accept:true});
    expect((await f.managerApi.workflow('b')).completedPlans).toEqual(['plan']);
    expect((await f.managerApi.events('b')).some(event=>event.kind==='prepare-dispatch'&&event.data.dispatchId==='d1')).toBe(true);
});
it('rejects cycles and incomplete output contracts without publishing any items or events',async()=>{
    const f=await fixture(),before=await f.store.read('b');f.plan.items[1].dependsOn=['api'];
    await expect(f.run(f.managerApi,{type:'publish-plan',plan:f.plan})).rejects.toMatchObject({code:'DEPENDENCY_CYCLE'});
    expect(await f.store.read('b')).toEqual(before);
    f.plan.items[1].dependsOn=[];await f.run(f.managerApi,{type:'publish-plan',plan:f.plan});await f.run(f.worker,{type:'prepare-dispatch',itemId:'schema',dispatchId:'d'});
    const fence=(await f.managerApi.workflow('b')).dispatches.d.fence,saved=await f.store.read('b');
    await expect(f.run(f.managerApi,{type:'observe-execution',dispatchId:'d',fence,outcome:'succeeded'})).rejects.toMatchObject({code:'REQUIRED_OUTPUT_MISSING'});
    expect(await f.store.read('b')).toEqual(saved);
});
it('persists lease renewal without repeating execution events or changing the task definition revision', async () => {
    vi.useFakeTimers({toFake: ['Date']});
    try {
        const f = await fixture(); await f.run(f.managerApi, {type: 'publish-plan', plan: f.plan});
        await f.run(f.worker, {type: 'prepare-dispatch', itemId: 'schema', dispatchId: 'heartbeat'});
        const fence = (await f.managerApi.workflow('b')).dispatches.heartbeat.fence;
        const observe = (outcome: 'running' | 'unknown', code?: string) => f.run(f.managerApi, {type: 'observe-execution', dispatchId: 'heartbeat', fence, outcome, code});
        await observe('running'); const before = (await f.managerApi.item('b', 'schema')).item;
        const events = (await f.managerApi.events('b')).length;
        vi.setSystemTime(Date.now() + 300000); await observe('running');
        const after = (await f.managerApi.item('b', 'schema')).item;
        expect(after.owner!.leaseUntil).toBeGreaterThan(before.owner!.leaseUntil);
        expect(after.revision).toBe(before.revision); expect(after.updatedAt).toBe(before.updatedAt);
        expect(await f.managerApi.events('b')).toHaveLength(events);
        await observe('unknown', 'OFFLINE'); await observe('unknown', 'OFFLINE');
        await observe('unknown', 'RECEIPT_MISSING'); await observe('running');
        expect((await f.managerApi.events('b')).filter(row => row.kind === 'observe-execution')).toHaveLength(4);
        await expect(f.run(f.managerApi, {type: 'observe-execution', dispatchId: 'heartbeat', fence: 'stale', outcome: 'running'})).rejects.toMatchObject({code: 'STALE_EXECUTION_RESULT'});
    } finally {vi.useRealTimers();}
});
it('does not reassign unknown work or accept stale callbacks, and blocks confirmed failures',async()=>{
    const f=await fixture();await f.run(f.managerApi,{type:'publish-plan',plan:f.plan});await f.run(f.worker,{type:'prepare-dispatch',itemId:'schema',dispatchId:'d'});
    const fence=(await f.managerApi.workflow('b')).dispatches.d.fence;
    await f.run(f.managerApi,{type:'observe-execution',dispatchId:'d',fence,outcome:'unknown',code:'TRANSPORT_LOST'});
    await expect(f.run(f.worker,{type:'prepare-dispatch',itemId:'schema',dispatchId:'other'})).rejects.toMatchObject({code:'WORK_NOT_READY'});
    await expect(f.run(f.managerApi,{type:'observe-execution',dispatchId:'d',fence:'wrong',outcome:'succeeded'})).rejects.toMatchObject({code:'STALE_EXECUTION_RESULT'});
    await f.run(f.managerApi,{type:'observe-execution',dispatchId:'d',fence,outcome:'failed',code:'WORK_FAILED'});
    expect((await f.managerApi.workflow('b')).ready).toEqual([]);expect((await f.managerApi.item('b','schema')).item.blocked?.reason).toBe('WORK_FAILED');
    await f.run(f.managerApi,{type:'unblock-item',itemId:'schema'});await f.run(f.worker,{type:'prepare-dispatch',itemId:'schema',dispatchId:'retry'});
    expect((await f.managerApi.workflow('b')).dispatches.retry.attempt).toBe(2);
    await expect(f.run(f.managerApi,{type:'observe-execution',dispatchId:'d',fence,outcome:'succeeded'})).rejects.toMatchObject({code:'STALE_EXECUTION_RESULT'});
});
it('extends a settled plan while preserving archived dependencies and their accepted artifacts',async()=>{
    const f=await fixture();f.plan.items=f.plan.items.filter(item=>item.id==='schema');await f.run(f.managerApi,{type:'publish-plan',plan:f.plan});
    await f.run(f.worker,{type:'prepare-dispatch',itemId:'schema',dispatchId:'d'});
    const fence=(await f.managerApi.workflow('b')).dispatches.d.fence,artifact={name:'schema',ref:'artifact:one',sha256:'a'.repeat(64),bytes:10};
    await f.run(f.managerApi,{type:'observe-execution',dispatchId:'d',fence,outcome:'succeeded',outputs:[artifact]});await f.run(f.managerApi,{type:'accept-execution',dispatchId:'d',accept:true});
    await f.run(f.managerApi,{type:'archive-items',itemIds:['schema'],reason:'Complete'});
    f.plan.revision=2;f.plan.items.push({id:'next',title:'Next',responsibility:'Build',acceptance:'Done',assignee:{kind:'service',id:'worker'},dependsOn:['schema'],inputs:{schema:{fromItemId:'schema',output:'schema'}}});
    await f.run(f.managerApi,{type:'publish-plan',plan:f.plan});await f.run(f.worker,{type:'prepare-dispatch',itemId:'next',dispatchId:'next-d'});
    expect((await f.managerApi.workflow('b')).dispatches['next-d'].inputs.schema).toEqual(artifact);
});
it('drains admitted work before shutdown while refusing new submissions',async()=>{
    const f=await fixture();let release!:()=>void,entered!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    const service=createKanbanModule({store:f.store,actor:{kind:'human',id:'owner'},authorize:async()=>{entered();await gate;},log:f.log});
    const request={id:'shutdown',title:'Shutdown',scope:{kind:'system' as const},members:[{kind:'human' as const,id:'owner',responsibility:'Manage',roles:['worker' as const]}]};
    const pending=service.create(request);await started;const closing=service.quiesce();
    await expect(service.create({...request,id:'late'})).rejects.toMatchObject({code:'SERVICE_STOPPING'});release();await pending;await closing;
    expect((await f.store.read('shutdown'))?.board.id).toBe('shutdown');await expect(service.read('shutdown')).rejects.toMatchObject({code:'SERVICE_STOPPING'});
});
it('requires verified immutable outputs and prevents bypassing a sealed plan through ordinary commands',async()=>{
    const f=await fixture();await f.run(f.managerApi,{type:'publish-plan',plan:f.plan});
    await expect(f.run(f.worker,{type:'claim',itemId:'schema'})).rejects.toMatchObject({code:'WORKFLOW_COMMAND_REQUIRED'});
    await f.run(f.worker,{type:'prepare-dispatch',itemId:'schema',dispatchId:'d'});
    const fence=(await f.managerApi.workflow('b')).dispatches.d.fence;
    await expect(f.run(f.worker,{type:'request-transfer',itemId:'schema',token:fence,target:{kind:'service',id:'manager'}})).rejects.toMatchObject({code:'EXECUTION_UNSETTLED'});
    const unverified=createKanbanModule({store:f.store,actor:{kind:'service',id:'manager'},authorize:async()=>{},log:f.log});
    await expect(f.run(unverified,{type:'observe-execution',dispatchId:'d',fence,outcome:'succeeded',outputs:[{name:'schema',ref:'artifact:one',sha256:'a'.repeat(64),bytes:10}]})).rejects.toMatchObject({code:'OUTPUT_VERIFICATION_REQUIRED'});
    expect((await f.managerApi.workflow('b')).dispatches.d.outcome).toBe('prepared');
    await expect(f.run(f.managerApi,{type:'review',itemId:'schema',accept:true})).rejects.toMatchObject({code:'WORKFLOW_COMMAND_REQUIRED'});
});
it('enforces the confirmed decision manager when publishing a plan',async()=>{
    const f=await fixture();
    await f.run(f.managerApi,{type:'append-record',record:{id:'decision',kind:'decision',title:'Build',content:'Scope',rationale:'Needed',itemIds:[],sources:[],coordination:{manager:{kind:'service',id:'manager'},executor:{kind:'service',id:'worker'}}}});
    const reviewer=createKanbanModule({store:f.store,actor:{kind:'human',id:'reviewer'},authorize:async()=>{},log:f.log});
    await f.run(reviewer,{type:'review-record',recordId:'decision',accept:true});
    f.plan.decisionId='decision';await expect(f.run(f.api('other-manager'),{type:'publish-plan',plan:f.plan})).rejects.toMatchObject({code:'DECISION_MANAGER_REQUIRED'});
    await f.run(f.managerApi,{type:'publish-plan',plan:f.plan});
    expect((await f.managerApi.workflow('b')).plans.plan.decisionId).toBe('decision');
    expect((await f.managerApi.record('b','decision')).coordination?.executor).toEqual({kind:'service',id:'worker'});
});
it('rolls back plan, outbox, numbering and receipt together when persistence fails mid-transaction',async()=>{
    const f=await fixture(),before=await f.store.read('b'),seq=f.fs.meta.seq!,records=f.backend.records,set=records.setRecordField.bind(records);
    const request={operationId:'atomic-plan',expectedRevision:before!.board.revision,command:{type:'publish-plan' as const,plan:f.plan}};
    const spy=vi.spyOn(records,'setRecordField').mockImplementation(async(path,key,value)=>{
        await set(path,key,value);
        if(key.includes('event/')) throw Object.assign(new Error('simulated commit failure'),{code:'STORAGE_UNAVAILABLE'});
    });
    await expect(f.managerApi.execute('b',request)).rejects.toMatchObject({code:'EIO'});spy.mockRestore();
    expect(await f.store.read('b')).toEqual(before);expect(await f.managerApi.events('b')).toEqual([]);
    expect(await seq.getEntry('/kanban/boards.seq','receipt/b/atomic-plan')).toBeNull();
    await f.managerApi.execute('b',request);await f.managerApi.execute('b',request);
    expect((await f.managerApi.read('b')).items).toHaveLength(2);
    expect((await f.managerApi.events('b')).filter(event=>event.kind==='publish-plan')).toHaveLength(1);
});
it('rejects malformed model-produced definitions with specific errors before publishing state',async()=>{
    const f=await fixture(),before=await f.store.read('b');
    const malformed=structuredClone(f.plan);malformed.items[0].inputs=[] as unknown as typeof malformed.items[0]['inputs'];
    await expect(f.run(f.managerApi,{type:'publish-plan',plan:malformed})).rejects.toMatchObject({code:'INVALID_INPUT_BINDINGS'});
    malformed.items[0].inputs={schema:{fromItemId:'schema',output:'undeclared'}};
    await expect(f.run(f.managerApi,{type:'publish-plan',plan:malformed})).rejects.toMatchObject({code:'OUTPUT_NOT_DECLARED'});
    expect(await f.store.read('b')).toEqual(before);
});
it('adopts existing unassigned work atomically without changing its identity or removing manual dependencies', async () => {
    const f = await fixture();
    await f.run(f.managerApi, {type: 'create-item', item: {id: 'first', title: 'First', responsibility: 'Prepare', acceptance: 'Verified'}});
    await f.run(f.managerApi, {type: 'create-item', item: {id: 'second', title: 'Second', responsibility: 'Deliver', acceptance: 'Verified'}, planning: {kind: 'task', priority: 1, dependencies: ['first'], references: []}});
    const original = (await f.managerApi.item('b', 'second')).item;
    const plan: KanbanWorkPlan = {schema: 'kanban.plan/1', id: 'adopt', revision: 1, sealed: true, items: [{id: original.id, title: original.title,
        responsibility: original.responsibility, acceptance: original.acceptance, expectedRevision: original.revision, assignee: {kind: 'service', id: 'worker'}, dependsOn: []}]};
    const before = await f.store.read('b');
    await expect(f.run(f.managerApi, {type: 'publish-plan', plan})).rejects.toMatchObject({code: 'EXISTING_DEPENDENCY_REQUIRED'});
    expect(await f.store.read('b')).toEqual(before);
    plan.items[0].dependsOn = ['first']; plan.items[0].expectedRevision = original.revision + 1;
    await expect(f.run(f.managerApi, {type: 'publish-plan', plan})).rejects.toMatchObject({code: 'PLAN_ITEM_CHANGED_REQUIRES_NEW_ID'});
    plan.items[0].expectedRevision = original.revision;
    await f.run(f.managerApi, {type: 'publish-plan', plan});
    const adopted = (await f.managerApi.item('b', 'second')).item;
    expect(adopted).toMatchObject({id: original.id, number: original.number, createdAt: original.createdAt, planning: {priority: 1, dependencies: ['first']}});
    expect((await f.managerApi.workflow('b')).ready).toEqual([]);
});

it('revalidates delivery at independent acceptance and leaves review pending if it changed', async () => {
    const f = await fixture(); await f.run(f.managerApi, {type: 'publish-plan', plan: f.plan});
    await f.run(f.worker, {type: 'prepare-dispatch', itemId: 'schema', dispatchId: 'delivery'});
    const dispatch = (await f.managerApi.workflow('b')).dispatches.delivery;
    const outputs = [{name: 'schema', ref: 'artifact:one', sha256: 'a'.repeat(64), bytes: 10}];
    await f.run(f.managerApi, {type: 'observe-execution', dispatchId: dispatch.id, fence: dispatch.fence, outcome: 'succeeded', outputs});
    f.verifyOutputs.mockResolvedValueOnce(false);
    await expect(f.run(f.managerApi, {type: 'accept-execution', dispatchId: dispatch.id, accept: true})).rejects.toMatchObject({code: 'OUTPUT_VERIFICATION_REQUIRED'});
    expect((await f.managerApi.item('b', 'schema')).item.status).toBe('review');
    expect(f.verifyOutputs.mock.calls.at(-1)?.[0]).toMatchObject({stage: 'accept', dispatchId: dispatch.id});
});

it('publishes typed subtasks atomically while keeping their parent non-executable until all children are accepted',async()=>{
    const f=await fixture(),reference={system:'remote-project',id:'project-one'};
    await f.run(f.managerApi,{type:'create-item',item:{id:'parent',title:'Parent',responsibility:'Deliver',acceptance:'All children accepted',externalRefs:[reference]}});
    const plan:KanbanWorkPlan={...f.plan,id:'children',rootItemId:'parent',items:[
        {id:'child-a',workType:'subtask',title:'A',responsibility:'First',acceptance:'Verified',externalRefs:[reference],assignee:{kind:'service',id:'worker'},dependsOn:[]},
        {id:'child-b',workType:'subtask',title:'B',responsibility:'Second',acceptance:'Verified',externalRefs:[reference],assignee:{kind:'service',id:'worker'},dependsOn:['child-a']}]};
    await f.run(f.managerApi,{type:'publish-plan',plan});
    expect((await f.managerApi.item('b','parent')).item.planning?.execution).toBe('children');
    expect((await f.managerApi.item('b','child-a')).item).toMatchObject({planning:{kind:'subtask',parentId:'parent'},externalRefs:[reference]});
    await expect(f.run(f.worker,{type:'claim',itemId:'parent'})).rejects.toMatchObject({code:'PLAN_NOT_EXECUTABLE'});
    await expect(f.run(f.managerApi,{type:'close-plan',itemId:'parent',resultRef:'premature'})).rejects.toMatchObject({code:'CHILDREN_UNFINISHED'});
    for(const id of ['child-a','child-b']) {
        await f.run(f.worker,{type:'prepare-dispatch',itemId:id,dispatchId:id});const dispatch=(await f.managerApi.workflow('b')).dispatches[id];
        await f.run(f.managerApi,{type:'observe-execution',dispatchId:id,fence:dispatch.fence,outcome:'succeeded'});
        await expect(f.run(f.managerApi,{type:'close-plan',itemId:'parent',resultRef:'premature'})).rejects.toMatchObject({code:'CHILDREN_UNFINISHED'});
        await f.run(f.managerApi,{type:'accept-execution',dispatchId:id,accept:true});
    }
    await f.run(f.managerApi,{type:'close-plan',itemId:'parent',resultRef:'children-reviewed'});
    expect((await f.managerApi.item('b','parent')).item.status).toBe('completed');expect((await f.managerApi.workflow('b')).ready).toEqual([]);
});
it('rolls back invalid subtask plans without converting the parent or creating partial children',async()=>{
    const f=await fixture();await f.run(f.managerApi,{type:'create-item',item:{id:'parent',title:'Parent',responsibility:'Deliver',acceptance:'Verified'}});
    const before=await f.store.read('b');
    await expect(f.run(f.managerApi,{type:'publish-plan',plan:{...f.plan,rootItemId:'parent'}})).rejects.toMatchObject({code:'INVALID_PARENT_KIND'});
    expect(await f.store.read('b')).toEqual(before);
});
it('appends new children atomically to a completed coordinator without replacing existing tasks or plans',async()=>{
    const f=await fixture();
    await f.run(f.managerApi,{type:'create-item',item:{id:'group',title:'Coordinator',responsibility:'Coordinate',acceptance:'Accepted children'},planning:{kind:'task',priority:2,dependencies:[],references:[]}});
    const child={id:'first',title:'First',responsibility:'Build',acceptance:'Verified',workType:'subtask',assignee:{kind:'service' as const,id:'worker'},dependsOn:[]};
    await f.run(f.managerApi,{type:'publish-plan',plan:{schema:'kanban.plan/1',id:'initial',revision:1,sealed:true,rootItemId:'group',coordination:true,items:[child]}});
    await f.run(f.worker,{type:'prepare-dispatch',itemId:'first',dispatchId:'initial-execution'});
    const fence=(await f.managerApi.workflow('b')).dispatches['initial-execution'].fence;
    await f.run(f.managerApi,{type:'observe-execution',dispatchId:'initial-execution',fence,outcome:'succeeded',outputs:[]});
    await f.run(f.managerApi,{type:'accept-execution',dispatchId:'initial-execution',accept:true});
    await f.run(f.managerApi,{type:'close-plan',itemId:'group',resultRef:'initial'});
    const first=await f.managerApi.item('b','first');
    const addition={schema:'kanban.plan/1' as const,id:'addition',revision:1,sealed:true,mode:'append' as const,rootItemId:'group',items:[{...child,id:'second',dependsOn:['first']}]};
    await f.run(f.managerApi,{type:'publish-plan',plan:addition});
    expect(await f.managerApi.item('b','first')).toEqual(first);
    expect((await f.managerApi.item('b','group')).item).toMatchObject({status:'backlog',planning:{execution:'children',coordination:true}});
    expect((await f.managerApi.item('b','second')).item.planning).toMatchObject({parentId:'group',dependencies:['first']});
    const before=await f.store.read('b');
    await expect(f.run(f.managerApi,{type:'publish-plan',plan:{...addition,id:'invalid',items:[{...child,id:'first'}]}})).rejects.toMatchObject({code:'APPEND_REQUIRES_NEW_ITEMS'});
    expect(await f.store.read('b')).toEqual(before);
});
it('revises a stopped decision in place and refuses to replace the content of a confirmed execution',async()=>{
    const f=await fixture(),reviewer=createKanbanModule({store:f.store,actor:{kind:'human',id:'reviewer'},authorize:async()=>{},log(){}});
    await f.run(f.managerApi,{type:'append-record',record:{id:'decision',kind:'decision',title:'Goal',content:'Original',rationale:'Verify',itemIds:[],sources:[]}});
    await f.run(reviewer,{type:'review-record',recordId:'decision',accept:true});
    await expect(f.run(reviewer,{type:'revise-record',recordId:'decision',title:'Goal',content:'Confirmed scope',rationale:'User clarification'})).rejects.toMatchObject({code:'RECORD_CANCEL_REQUIRED'});
    await f.run(reviewer,{type:'cancel-record',recordId:'decision'});
    const before=await reviewer.record('b','decision');
    await f.run(reviewer,{type:'revise-record',recordId:'decision',title:'Goal',content:'Confirmed scope',rationale:'User clarification'});
    const after=await reviewer.record('b','decision');expect(after).toMatchObject({id:before.id,number:before.number,status:'cancelled',content:'Confirmed scope',revision:before.revision+1});
    expect(before.content).toBe('Original');
});
it('freezes explicit automatic completion with the approved decision',async()=>{
 const f=await fixture();await f.run(f.managerApi,{type:'append-record',record:{id:'auto-decision',kind:'decision',title:'Automatic',content:'Scope',rationale:'Verify all',itemIds:[],sources:[],completion:'automatic'}});
 expect((await f.managerApi.record('b','auto-decision')).completion).toBe('automatic');
 await expect(f.run(f.managerApi,{type:'append-record',record:{id:'bad-auto',kind:'log',title:'Invalid',content:'Scope',itemIds:[],sources:[],completion:'automatic'}})).rejects.toMatchObject({code:'INVALID_COMPLETION_POLICY'});
});
it('persists decision preferences, revises them only before execution, and rejects invalid values atomically',async()=>{
 const f=await fixture(),reviewer=createKanbanModule({store:f.store,actor:{kind:'human',id:'reviewer'},authorize:async()=>{},log(){}});
 const record={id:'choices',kind:'decision' as const,title:'Choices',content:'Scope',rationale:'Verify',itemIds:[],sources:[],verificationLevel:'quick' as const,deliveryMode:'release' as const};
 await f.run(f.managerApi,{type:'append-record',record});
 expect(await reviewer.record('b','choices')).toMatchObject({verificationLevel:'quick',deliveryMode:'release'});
 await f.run(reviewer,{type:'revise-record',recordId:'choices',title:'Choices',content:'Scope',rationale:'Verify',verificationLevel:'none',deliveryMode:'build'});
 expect(await reviewer.record('b','choices')).toMatchObject({verificationLevel:'none',deliveryMode:'build'});
 await f.run(reviewer,{type:'revise-record',recordId:'choices',title:'Choices',content:'Scope',rationale:'Verify',verificationLevel:'none',deliveryMode:'release'});
 expect(await reviewer.record('b','choices')).toMatchObject({verificationLevel:'none',deliveryMode:'release'});
 const before=await f.store.read('b');
 await expect(f.run(f.managerApi,{type:'append-record',record:{...record,id:'bad',verificationLevel:'invalid' as any}})).rejects.toMatchObject({code:'INVALID_VERIFICATION_LEVEL'});
 await expect(f.run(f.managerApi,{type:'append-record',record:{...record,id:'bad',deliveryMode:'invalid' as any}})).rejects.toMatchObject({code:'INVALID_DELIVERY_MODE'});
 await expect(f.run(f.managerApi,{type:'append-record',record:{...record,id:'bad',kind:'log'}})).rejects.toMatchObject({code:'INVALID_VERIFICATION_LEVEL'});
 expect(await f.store.read('b')).toEqual(before);
});
it('holds related unstarted tasks durably and atomically applies only the confirmed revisions',async()=>{
 const f=await fixture(),reviewer=createKanbanModule({store:f.store,actor:{kind:'human',id:'reviewer'},authorize:async()=>{},log(){}});
 for(const id of ['a','b'])await f.run(f.managerApi,{type:'create-item',item:{id,title:id,responsibility:'Before',acceptance:'Evidence'},planning:{kind:'task',priority:2,dependencies:[],references:[]}});
 await f.run(f.managerApi,{type:'append-record',record:{id:'d',kind:'decision',title:'Decision',content:'Before',rationale:'Evidence',itemIds:['a','b'],sources:[]}});
 expect((await reviewer.record('b','d')).completion).toBe('automatic');
 const revision=(await reviewer.record('b','d')).revision,items=(await reviewer.read('b')).items;
 await f.run(reviewer,{type:'begin-record-edit',recordId:'d',recordRevision:revision,editId:'discussion-edit',items:items.map(item=>({id:item.id,revision:item.revision}))});
 const held=(await reviewer.read('b')).items;expect(held.every(item=>item.launch?.editing?.persistent)).toBe(true);
 await expect(f.run(f.worker,{type:'claim',itemId:'a'})).rejects.toMatchObject({code:'EDIT_LEASE_ACTIVE'});
 await expect(f.run(reviewer,{type:'save-record-edit',recordId:'d',recordRevision:revision,editId:'discussion-edit',title:'Decision',content:'Changed',rationale:'Evidence',items:items.map(item=>({id:item.id,revision:item.revision,title:item.title,responsibility:'Changed',acceptance:item.acceptance}))})).rejects.toMatchObject({code:'ITEM_REVISION_CONFLICT'});
 expect((await reviewer.read('b')).items.every(item=>item.launch?.editing?.persistent)).toBe(true);
 await f.run(reviewer,{type:'save-record-edit',recordId:'d',recordRevision:revision,editId:'discussion-edit',title:'Decision',content:'Changed',rationale:'Evidence',items:held.map(item=>({id:item.id,revision:item.revision,title:item.title,responsibility:'Changed',acceptance:item.acceptance}))});
 expect((await reviewer.read('b')).items.every(item=>item.responsibility==='Changed'&&!item.launch?.editing)).toBe(true);
});
it('rolls back every hold when a selected task has already started',async()=>{
 const f=await fixture(),reviewer=createKanbanModule({store:f.store,actor:{kind:'human',id:'reviewer'},authorize:async()=>{},log(){}});
 for(const id of ['a','b'])await f.run(f.managerApi,{type:'create-item',item:{id,title:id,responsibility:'Before',acceptance:'Evidence'}});
 await f.run(f.managerApi,{type:'set-stage',itemId:'b',stage:'open'});await f.run(f.worker,{type:'claim',itemId:'b'});
 await f.run(f.managerApi,{type:'append-record',record:{id:'d',kind:'decision',title:'Decision',content:'Before',rationale:'Evidence',itemIds:['a','b'],sources:[]}});
 const before=await f.store.read('b'),record=await reviewer.record('b','d');
 await expect(f.run(reviewer,{type:'begin-record-edit',recordId:'d',recordRevision:record.revision,editId:'discussion-edit',items:(await reviewer.read('b')).items.map(item=>({id:item.id,revision:item.revision}))})).rejects.toMatchObject({code:'TASK_DEFINITION_FROZEN'});
 expect(await f.store.read('b')).toEqual(before);
});
