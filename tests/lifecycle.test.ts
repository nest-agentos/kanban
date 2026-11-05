import {createKanbanExecutionBridge} from '../src/execution';
import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule, SeqKanbanStore} from '../src';
import type {KanbanCommand} from '../src/contracts';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0)) await close();});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), store = await SeqKanbanStore.open(fs);
    const actor = {kind:'human' as const, id:'admin'};
    const service = createKanbanModule({store, actor, authorize:async () => {}, log() {}});
    await service.create({id:'b', title:'Board', scope:{kind:'system'}, members:[{...actor, responsibility:'Manage', roles:['coordinator','reviewer','worker']}], policy:{requireEstimate:false}});
    let n = 0;
    const run = async (command:KanbanCommand) => service.execute('b', {operationId:'op-' + ++n, expectedRevision:(await service.read('b')).revision, command});
    await run({type:'publish-plan', plan:{schema:'kanban.plan/1',id:'p',revision:1,sealed:true,items:[{id:'t',title:'Task',responsibility:'Work',acceptance:'Verify',assignee:actor,dependsOn:[]}]}});
    return {service,run,fs};
}
it('cancels the original dispatch through a control receipt, deletes logically and preserves history and identity', async () => {
    const f = await fixture(); await f.run({type:'prepare-dispatch',itemId:'t',dispatchId:'original'});
    await f.run({type:'request-control',itemId:'t',controlId:'cancel',action:'cancel'});
    expect((await f.service.item('b','t')).task?.phase).toBe('cancelling');
    await f.run({type:'control-receipt',itemId:'t',controlId:'cancel',state:'accepted'});
    expect((await f.service.item('b','t')).item.owner).toBeDefined();
    await expect(f.run({type:'delete-item',itemId:'t'})).rejects.toMatchObject({code:'EXECUTION_UNSETTLED'});
    await f.run({type:'control-receipt',itemId:'t',controlId:'cancel',state:'cancelled'});
    expect((await f.service.item('b','t')).item).toMatchObject({status:'cancelled',control:{state:'cancelled'}});
    expect((await f.service.item('b','t')).item.owner).toBeUndefined();
    expect((await f.service.workflow('b')).dispatches.original.outcome).toBe('cancelled');
    await f.run({type:'delete-item',itemId:'t'});
    expect((await f.service.query('b',{view:'all'})).items).toEqual([]);
    expect((await f.service.query('b',{view:'all',includeDeleted:true})).items).toHaveLength(1);
    expect((await f.service.overview('b')).visible).toBe(0);
    expect((await f.service.catalog())[0].items).toEqual([]);
    expect((await f.service.item('b','t')).item.deletedAt).toBeTypeOf('number');
    expect((await f.service.events('b')).some(event => event.kind === 'delete-item')).toBe(true);
    await expect(f.run({type:'create-item',item:{id:'t',title:'Again',responsibility:'Work',acceptance:'Verify'}})).rejects.toMatchObject({code:'ITEM_EXISTS'});
});
it('keeps cancellation identity stable and prevents late receipts or manual admission from restarting work', async () => {
    const f = await fixture(); await f.run({type:'request-control',itemId:'t',controlId:'pause',action:'pause'});
    await f.run({type:'request-control',itemId:'t',controlId:'cancel',action:'cancel'});
    await f.run({type:'request-control',itemId:'t',controlId:'other-cancel',action:'cancel'});
    expect((await f.service.item('b','t')).item.control?.id).toBe('cancel');
    await expect(f.run({type:'control-receipt',itemId:'t',controlId:'pause',state:'paused'})).rejects.toMatchObject({code:'STALE_CONTROL_RECEIPT'});
    await expect(f.run({type:'prepare-dispatch',itemId:'t',dispatchId:'late'})).rejects.toMatchObject({code:'TASK_CONTROL_PENDING'});
});
it('cascades cancellation and keeps the parent pending until the children settle', async () => {
    const f=await fixture();
    await f.run({type:'create-item',item:{id:'root',title:'Parent',responsibility:'Coordinate',acceptance:'Review'},planning:{kind:'feature',priority:2,dependencies:[],references:[]}});
    await f.run({type:'create-item',item:{id:'child',title:'Child',responsibility:'Work',acceptance:'Verify'},planning:{kind:'task',parentId:'root',priority:2,dependencies:[],references:[]}});
    await f.run({type:'request-control',itemId:'root',controlId:'root-cancel',action:'cancel'});
    const child=(await f.service.item('b','child')).item;
    expect(child.control?.action).toBe('cancel');
    await expect(f.run({type:'control-receipt',itemId:'root',controlId:'root-cancel',state:'cancelled'})).rejects.toMatchObject({code:'CHILDREN_UNFINISHED'});
    await f.run({type:'control-receipt',itemId:'child',controlId:child.control!.id,state:'cancelled'});
    await f.run({type:'control-receipt',itemId:'root',controlId:'root-cancel',state:'cancelled'});
    expect((await f.service.item('b','root')).item.status).toBe('cancelled');
});
it('cancels and deletes decisions while preserving their immutable history', async () => {
    const f=await fixture();
    await f.run({type:'append-record',record:{id:'decision',kind:'decision',title:'Decision',content:'Scope',rationale:'Verify',itemIds:['t'],sources:[]}});
    await expect(f.run({type:'cancel-record',recordId:'decision'})).rejects.toMatchObject({code:'RECORD_EXECUTION_UNSETTLED'});
    await f.run({type:'cancel-item',itemId:'t',reason:'No longer needed'});
    await f.run({type:'cancel-record',recordId:'decision'});
    await f.run({type:'delete-record',recordId:'decision'});
    expect((await f.service.records('b',{kind:'decision'})).items).toEqual([]);
    expect((await f.service.records('b',{kind:'decision',includeDeleted:true})).items).toHaveLength(1);
    expect(await f.service.record('b','decision')).toMatchObject({status:'cancelled',deletedAt:expect.any(Number)});
});

it('freezes the whole board before dispatch, and drains an already submitted execution without starting another',async()=>{
    const f=await fixture();await f.run({type:'prepare-dispatch',itemId:'t',dispatchId:'original'});
    const executor={prepare:vi.fn(async()=>({id:'original'})),start:vi.fn(async()=>({outcome:'running' as const})),inspect:vi.fn(async()=>({outcome:'running' as const}))};
    const bridge=await createKanbanExecutionBridge({fs:f.fs,directory:'/bridge',boardId:'b',service:f.service,worker:async()=>f.service,executor,autoDispatch:true,authorize:async()=>{},log(){}});closes.push(()=>bridge.quiesce());
    await bridge.scan();expect(executor.start).toHaveBeenCalledOnce();
    await f.run({type:'request-board-stop',controlId:'delete-board',intent:'delete',mode:'drain'});
    await bridge.scan();
    expect(executor.start).toHaveBeenCalledOnce();expect(executor.inspect).toHaveBeenCalledOnce();
    expect((await f.service.item('b','t')).item.owner).toBeDefined();
    expect((await f.service.workflow('b')).dispatches.original.outcome).toBe('running');
    await expect(f.run({type:'request-run',itemId:'t'})).rejects.toMatchObject({code:'BOARD_STOPPING'});
    await expect(f.run({type:'create-item',item:{id:'new',title:'New',responsibility:'Work',acceptance:'Verify'}})).rejects.toMatchObject({code:'BOARD_STOPPING'});
    await expect(f.run({type:'set-board-control',paused:false})).rejects.toMatchObject({code:'BOARD_STOPPING'});
});
it('does not start a prepared dispatch after the board enters pending deletion',async()=>{
    const f=await fixture();await f.run({type:'prepare-dispatch',itemId:'t',dispatchId:'original'});
    await f.run({type:'request-board-stop',controlId:'delete-board',intent:'delete',mode:'drain'});
    const executor={prepare:vi.fn(),start:vi.fn(),inspect:vi.fn()};
    const bridge=await createKanbanExecutionBridge({fs:f.fs,directory:'/bridge',boardId:'b',service:f.service,worker:async()=>f.service,executor,autoDispatch:true,authorize:async()=>{},log(){}});closes.push(()=>bridge.quiesce());
    await bridge.scan();expect(executor.start).not.toHaveBeenCalled();expect(executor.prepare).not.toHaveBeenCalled();
    expect((await f.service.workflow('b')).dispatches.original).toMatchObject({outcome:'cancelled',code:'CANCELLED_BEFORE_START'});
});
