import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule, SeqKanbanStore, type KanbanCommand, type KanbanModuleHandle} from '../src';
import {createKanbanExecutionBridge, type KanbanExecutionPort} from '../src/execution';
const closes: Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse()) await close();});
async function fixture(autoAccept=false) {
    const backend=new MemoryBackend(),{manager}=await createVFS({rootBackend:backend});closes.push(()=>manager.dispose());
    const fs=await manager.openFileSystem('/'),store=await SeqKanbanStore.open(fs), log=vi.fn();
    const api=(id:string)=>createKanbanModule({store,actor:{kind:'service',id},authorize:async()=>{},log,now:()=>Date.now()});
    const service=api('manager'),worker=api('worker');let serial=0;
    await service.create({id:'b',title:'Work',scope:{kind:'system'},members:[{kind:'service',id:'manager',responsibility:'Manage',roles:['coordinator','reviewer']},{kind:'service',id:'worker',responsibility:'Build',roles:['worker']}],policy:{requireEstimate:false,review:autoAccept?'assignee':'independent'}});
    const run=async(command:KanbanCommand,actor:KanbanModuleHandle=service)=>actor.execute('b',{operationId:`op-${++serial}`,expectedRevision:(await actor.read('b')).revision,command});
    await run({type:'publish-plan',plan:{schema:'kanban.plan/1',id:'p',revision:1,sealed:true,items:['first','second'].map((id,i)=>({id,title:id,responsibility:'Work',acceptance:'Done',assignee:{kind:'service',id:'worker'},dependsOn:i?['first']:[]}))}});
    const executor:KanbanExecutionPort={prepare:vi.fn(async dispatch=>({dispatchId:dispatch.id})),start:vi.fn(async()=>({outcome:'running'})),inspect:vi.fn(async()=>({outcome:'unknown',code:'RECEIPT_MISSING'}))};
    const bridge=async(autoDispatch=false,port=executor)=>{
        const bridge=await createKanbanExecutionBridge({executionReference:(id,revision)=>({system:'external-execution',id,revision}),fs,directory:'/bridge',boardId:'b',service,worker:async()=>worker,executor:port,authorize:async()=>{},log,autoDispatch,shutdownTimeoutMs:5});
        closes.push(()=>bridge.quiesce());return bridge;
    };
    const prepare=()=>run({type:'prepare-dispatch',itemId:'first',dispatchId:'d'},worker);
    return {fs,service,worker,run,executor,bridge,prepare,log,backend};
}
it('preserves submission identity after response loss and only inspects it after restart',async()=>{
    const f=await fixture();await f.prepare();
    vi.mocked(f.executor.start).mockRejectedValueOnce(Object.assign(new Error('secret request body'),{code:'TRANSPORT_LOST'}));
    const bridge=await f.bridge();await bridge.scan();await bridge.quiesce();
    expect((await f.service.workflow('b')).dispatches.d.outcome).toBe('unknown');
    const restarted=await f.bridge();await restarted.scan();await restarted.scan();
    expect(f.executor.start).toHaveBeenCalledTimes(1);expect(f.executor.prepare).toHaveBeenCalledTimes(1);expect(f.executor.inspect).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('secret request body');
});
it('continues with a new fence, preserves the failed attempt and restores only the new request after restart', async () => {
    const f = await fixture(); await f.prepare();
    vi.mocked(f.executor.start).mockResolvedValueOnce({outcome: 'failed', code: 'EFFECT_TIMEOUT'});
    const first = await f.bridge(); await first.scan(); await first.quiesce();
    const old = (await f.service.workflow('b')).dispatches.d;
    f.executor.prepareContinuation = vi.fn(async (dispatch, _item, previous) => ({dispatchId: dispatch.id, previous}));
    await f.run({type: 'continue-execution', previousDispatchId: 'd', dispatchId: 'continued'});
    const next = (await f.service.workflow('b')).dispatches.continued;
    expect(next.fence).not.toBe(old.fence); expect(next.continuation).toEqual({previousDispatchId: 'd'});
    await expect(f.run({type: 'observe-execution', dispatchId: 'd', fence: old.fence, outcome: 'succeeded'})).rejects.toMatchObject({code: 'STALE_EXECUTION_RESULT'});
    vi.mocked(f.executor.start).mockRejectedValueOnce(Object.assign(new Error('lost response'), {code: 'EIO'}));
    const running = await f.bridge(); await running.scan(); await running.quiesce();
    const restarted = await f.bridge(); await restarted.scan();
    expect(f.executor.start).toHaveBeenCalledTimes(2); expect(f.executor.prepareContinuation).toHaveBeenCalledOnce();
    expect(f.executor.prepareContinuation).toHaveBeenCalledWith(expect.objectContaining({id: 'continued'}), expect.anything(), {dispatchId: 'd'});
    expect((await f.service.workflow('b')).dispatches.d).toEqual(old);
    await expect(f.run({type: 'continue-execution', previousDispatchId: 'd', dispatchId: 'duplicate'})).rejects.toMatchObject({code: 'ITEM_NOT_CONTINUABLE'});
});
it('refuses continuation for completed work and by a worker without coordinator authority', async () => {
    const f = await fixture(true); await f.prepare();
    vi.mocked(f.executor.start).mockResolvedValueOnce({outcome: 'succeeded'});
    const bridge = await f.bridge(); await bridge.scan();
    await expect(f.run({type: 'continue-execution', previousDispatchId: 'd', dispatchId: 'extra'})).rejects.toMatchObject({code: 'EXECUTION_NOT_CONTINUABLE'});
    await expect(f.run({type: 'continue-execution', previousDispatchId: 'd', dispatchId: 'extra'}, f.worker)).rejects.toMatchObject({code: 'COORDINATOR_REQUIRED'});
});
it('retries the same frozen request after a confirmed unstarted admission across restart', async () => {
    const f = await fixture(); await f.prepare();
    vi.mocked(f.executor.start).mockRejectedValueOnce(Object.assign(new Error('read only'),
        {code: 'QUEUE_READ_ONLY', executionOutcome: 'not-started', retryable: true}));
    const bridge = await f.bridge(); await bridge.scan(); await bridge.quiesce();
    expect((await f.service.workflow('b')).dispatches.d.outcome).toBe('unknown');
    const recovered = await f.bridge(); await recovered.scan();
    expect(f.executor.prepare).toHaveBeenCalledOnce(); expect(f.executor.start).toHaveBeenCalledTimes(2);
    expect(f.executor.start).toHaveBeenNthCalledWith(1, {dispatchId: 'd'});
    expect(f.executor.start).toHaveBeenNthCalledWith(2, {dispatchId: 'd'});
});
it('allows only one submitting bridge across concurrent observers',async()=>{
    const f=await fixture();await f.prepare();const first=await f.bridge(),second=await f.bridge();
    await Promise.all([first.scan(),second.scan()]);
    expect(f.executor.start).toHaveBeenCalledTimes(1);expect(f.executor.inspect).toHaveBeenCalledTimes(1);
});
it('keeps healthy inspections silent and records an actual observation change', async () => {
    const f = await fixture(); await f.prepare(); const bridge = await f.bridge(); await bridge.scan();
    const inspectLogs = () => f.log.mock.calls.filter(([row]) => row.stage === 'bridge.inspect');
    vi.mocked(f.executor.inspect).mockResolvedValue({outcome: 'running'});
    await bridge.scan(); await bridge.scan(); expect(inspectLogs()).toHaveLength(0);
    vi.mocked(f.executor.inspect).mockResolvedValue({outcome: 'unknown', code: 'OFFLINE'});
    await bridge.scan(); await bridge.scan(); expect(inspectLogs()).toHaveLength(1);
    vi.mocked(f.executor.inspect).mockResolvedValue({outcome: 'running'});
    await bridge.scan(); expect(inspectLogs()).toHaveLength(2); expect(f.executor.start).toHaveBeenCalledOnce();
});
it('links the actual execution Session to the work item once, retaining the dispatch identity',async()=>{
    const f=await fixture();await f.prepare();vi.mocked(f.executor.start).mockResolvedValueOnce({outcome:'running',executionSessionId:'execution-session'});
    const bridge=await f.bridge();await bridge.scan();
    expect((await f.service.item('b','first')).item.externalRefs).toEqual([{system:'external-execution',id:'execution-session',revision:'d'}]);
    vi.mocked(f.executor.inspect).mockResolvedValueOnce({outcome:'running',executionSessionId:'execution-session'});await bridge.scan();
    expect((await f.service.item('b','first')).item.externalRefs).toHaveLength(1);expect(f.executor.start).toHaveBeenCalledTimes(1);
});
it('ignores late responses after bounded shutdown and reconciles the original dispatch on restart',async()=>{
    const f=await fixture();await f.prepare();let release!:(value:{outcome:'succeeded'})=>void,entered!:()=>void;
    const gate=new Promise<{outcome:'succeeded'}>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    vi.mocked(f.executor.start).mockImplementationOnce(async()=>{entered();return gate;});
    const bridge=await f.bridge(),scan=bridge.scan();await started;await bridge.quiesce();
    release({outcome:'succeeded'});await scan;
    expect((await f.service.workflow('b')).dispatches.d.outcome).toBe('prepared');
    vi.mocked(f.executor.inspect).mockResolvedValueOnce({outcome:'succeeded'});
    const restarted=await f.bridge();await restarted.scan();
    expect((await f.service.workflow('b')).dispatches.d.outcome).toBe('succeeded');expect(f.executor.start).toHaveBeenCalledTimes(1);
});
it('advances a sealed DAG with explicit automatic acceptance, and stops for independent review',async()=>{
    const f=await fixture(true);vi.mocked(f.executor.start).mockResolvedValue({outcome:'succeeded'});
    await f.run({type:'request-run',itemId:'first'});await f.run({type:'request-run',itemId:'second'});
    const bridge=await f.bridge(true);await bridge.scan();await bridge.scan();
    expect((await f.service.workflow('b')).completedPlans).toEqual(['p']);expect(f.executor.start).toHaveBeenCalledTimes(2);
    const independent=await fixture();vi.mocked(independent.executor.start).mockResolvedValue({outcome:'succeeded'});
    await independent.run({type:'request-run',itemId:'first'});
    const guarded=await independent.bridge(true);await guarded.scan();await guarded.scan();
    expect((await independent.service.workflow('b')).completedPlans).toEqual([]);expect(independent.executor.start).toHaveBeenCalledTimes(1);
});
it('drains a journal transaction beyond the external-observation timeout before releasing storage',async()=>{
    const f=await fixture();await f.prepare();const bridge=await f.bridge();
    let release!:()=>void,entered!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    const records=f.backend.records,set=records.setRecordField.bind(records);
    const spy=vi.spyOn(records,'setRecordField').mockImplementation(async(path,key,value)=>{
        if(path==='/bridge/executions.seq'&&typeof value==='string'&&JSON.parse(value).phase==='prepared') {entered();await gate;}
        return set(path,key,value);
    });
    const scan=bridge.scan();await started;let closed=false;
    const closing=bridge.quiesce().then(()=>{closed=true;});
    await new Promise(resolve=>setTimeout(resolve,15));expect(closed).toBe(false);
    release();await closing;await scan;spy.mockRestore();expect(f.executor.start).not.toHaveBeenCalled();
});
it('reports a corrupt frozen request without executing or inspecting it',async()=>{
    const f=await fixture();await f.prepare();const bridge=await f.bridge();await bridge.scan();await bridge.quiesce();
    const path='/bridge/executions.seq',record=JSON.parse((await f.fs.meta.seq!.getEntry(path,'d'))!);
    await f.fs.meta.seq!.setEntry(path,'d',JSON.stringify({...record,request:{dispatchId:'different'}}));
    const restarted=await f.bridge();await restarted.scan();
    expect(f.executor.start).toHaveBeenCalledTimes(1);expect(f.executor.inspect).not.toHaveBeenCalled();
    expect((await f.service.workflow('b')).dispatches.d).toMatchObject({outcome:'unknown',code:'INVALID_EXECUTION_JOURNAL'});
});
it('settles preparation failures as not-started work without calling the executor', async () => {
    const f = await fixture(); await f.prepare();
    vi.mocked(f.executor.prepare).mockRejectedValueOnce(Object.assign(new Error('PRIVATE'), {code: 'DEPENDENCY_CONTEXT_TOO_LARGE'}));
    const bridge = await f.bridge(); await bridge.scan();
    expect((await f.service.workflow('b')).dispatches.d).toMatchObject({outcome: 'failed', code: 'DEPENDENCY_CONTEXT_TOO_LARGE'});
    expect(f.executor.start).not.toHaveBeenCalled();
    expect((await f.service.item('b', 'first')).item.blocked?.reason).toBe('DEPENDENCY_CONTEXT_TOO_LARGE');
    await bridge.quiesce();
});
it('reconciles repeated running/unknown transitions and renews the same fenced owner', async () => {
    const f = await fixture(); await f.prepare(); const bridge = await f.bridge();
    await bridge.scan();
    await bridge.scan();
    vi.mocked(f.executor.inspect).mockResolvedValueOnce({outcome: 'running'}); await bridge.scan();
    expect((await f.service.workflow('b')).dispatches.d.outcome).toBe('running');
    await bridge.scan();
    expect((await f.service.workflow('b')).dispatches.d).toMatchObject({outcome: 'unknown', code: 'RECEIPT_MISSING'});
    const before = (await f.service.item('b', 'first')).item.owner!;
    const time = vi.spyOn(Date, 'now').mockReturnValue(before.leaseUntil + 1);
    try {
        await bridge.scan();
        const after = (await f.service.item('b', 'first')).item.owner!;
        expect(after.token).toBe(before.token); expect(after.leaseUntil).toBeGreaterThan(Date.now());
        await f.run({type: 'block-item', itemId: 'first', token: after.token, reason: 'Needs clarification'}, f.worker);
    } finally {time.mockRestore();}
    expect(f.executor.start).toHaveBeenCalledTimes(1);
});
it('backs off thrown observation failures and recovers the original attempt without replaying work', async () => {
    const f = await fixture(); await f.prepare(); const bridge = await f.bridge(); await bridge.scan();
    const clock = vi.spyOn(Date, 'now'), start = Date.now(); clock.mockReturnValue(start);
    try {
        vi.mocked(f.executor.inspect).mockRejectedValue(Object.assign(new Error('PRIVATE'), {code: 'ARTIFACT_CONFLICT'}));
        await bridge.scan(); await bridge.scan();
        expect(f.executor.inspect).toHaveBeenCalledTimes(1);
        expect((await f.service.workflow('b')).dispatches.d).toMatchObject({outcome: 'unknown', code: 'ARTIFACT_CONFLICT'});
        clock.mockReturnValue(start + 1000); await bridge.scan(); await bridge.scan();
        expect(f.executor.inspect).toHaveBeenCalledTimes(2);
        clock.mockReturnValue(start + 2000); await bridge.scan(); expect(f.executor.inspect).toHaveBeenCalledTimes(2);
        clock.mockReturnValue(start + 3000); vi.mocked(f.executor.inspect).mockResolvedValue({outcome: 'succeeded'});
        await bridge.scan(); expect((await f.service.workflow('b')).dispatches.d.outcome).toBe('succeeded');
        expect(f.executor.start).toHaveBeenCalledTimes(1); expect(f.executor.prepare).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(f.log.mock.calls)).not.toContain('PRIVATE');
    } finally {clock.mockRestore();}
});

it('recovers the original frozen Session request after a continuation fails before submission',async()=>{
 const f=await fixture();await f.prepare();vi.mocked(f.executor.start).mockResolvedValueOnce({outcome:'failed',code:'VERIFICATION_FAILED',executionSessionId:'original-session'});
 const bridge=await f.bridge();await bridge.scan();
 f.executor.prepareContinuation=vi.fn().mockRejectedValueOnce(Object.assign(new Error('Blocked'),{code:'WORKTREE_EXECUTION_UNKNOWN'})).mockImplementation(async(dispatch,_item,previous)=>({dispatchId:dispatch.id,previous}));
 await f.run({type:'continue-execution',previousDispatchId:'d',dispatchId:'failed-preparation'});await bridge.scan();
 expect((await f.service.workflow('b')).dispatches['failed-preparation'].outcome).toBe('failed');
 await f.run({type:'continue-execution',previousDispatchId:'failed-preparation',dispatchId:'recovered'});await bridge.scan();
 expect(f.executor.prepareContinuation).toHaveBeenLastCalledWith(expect.objectContaining({id:'recovered'}),expect.anything(),{dispatchId:'d'});
 expect(f.executor.start).toHaveBeenCalledTimes(2);expect((await f.service.workflow('b')).dispatches.recovered.attempt).toBe(3);
 expect((await f.service.workflow('b')).dispatches['failed-preparation'].outcome).toBe('failed');
});
