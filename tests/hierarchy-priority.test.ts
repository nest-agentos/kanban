import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule,SeqKanbanStore} from '../src';
import {migrateTaskHierarchy} from '../src/storage';
import type {KanbanCommand} from '../src/contracts';
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0))await close();});
async function fixture(){
    const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());
    const store=await SeqKanbanStore.open(await manager.openFileSystem('/'));
    const service=createKanbanModule({store,actor:{kind:'human',id:'owner'},authorize:async()=>{},log(){}});
    await service.create({id:'b',title:'Board',scope:{kind:'system'},members:[{kind:'human',id:'owner',responsibility:'Manage',roles:['coordinator','reviewer','worker']}],policy:{requireEstimate:false,maxInProgressPerAssignee:2}});
    let serial=0;const run=async(command:KanbanCommand)=>service.execute('b',{operationId:'op-'+ ++serial,expectedRevision:(await service.read('b')).revision,command});
    const create=(id:string,parentId?:string)=>run({type:'create-item',item:{id,title:id,responsibility:'Work',acceptance:'Evidence'},planning:{kind:'task',parentId,priority:2,dependencies:[],references:[]}});
    return {store,service,run,create};
}
it('enforces two levels atomically across create, planning and plan publication',async()=>{
    const f=await fixture();await f.create('manager');await f.create('leaf','manager');const before=await f.store.read('b');
    await expect(f.create('nested','leaf')).rejects.toMatchObject({code:'EXECUTION_PARENT_REQUIRED'});
    await expect(f.run({type:'mark-planning',itemId:'leaf'} as KanbanCommand)).rejects.toMatchObject({code:'EXECUTION_CANNOT_HAVE_CHILDREN'});
    await expect(f.run({type:'create-item',item:{id:'orphan',taskType:'execution',title:'Orphan',responsibility:'Work',acceptance:'Done'}})).rejects.toMatchObject({code:'EXECUTION_PARENT_REQUIRED'});
    expect(await f.store.read('b')).toEqual(before);
});
it('migrates legacy nesting and orphans once while retaining identities, Session bindings and execution receipts',async()=>{
    const f=await fixture();await f.create('root');await f.create('parent','root');await f.create('leaf','root');
    await f.store.update('b','legacy','legacy',state=>{
        for(const item of state!.board.items)delete item.taskType;
        state!.board.items[0].planning!.execution=undefined;
        state!.board.items[1].planning!.execution=undefined;
        state!.board.items[2].planning!.parentId='parent';
        state!.board.items[2].externalRefs=[{system:'execution',id:'original-session',revision:'original-dispatch'}];
        const orphan=structuredClone(state!.board.items[2]);orphan.id='orphan';delete orphan.number;delete orphan.planning!.parentId;state!.board.items.push(orphan);
        return state!;
    });
    const before=(await f.store.read('b'))!,original=new Map(before.board.items.map(item=>[item.id,item]));
    const log=vi.fn(),options={actor:{kind:'service' as const,id:'migration'},ungrouped:{title:'Ungrouped',responsibility:'Coordinate',acceptance:'Accepted children'},log};
    await migrateTaskHierarchy(f.store,options);const after=(await f.store.read('b'))!;
    expect(after.board.items.find(item=>item.id==='parent')).toMatchObject({taskType:'coordination',planning:{execution:'children'}});
    expect(after.board.items.find(item=>item.id==='parent')!.planning!.parentId).toBeUndefined();
    expect(after.board.items.find(item=>item.id==='leaf')).toMatchObject({taskType:'execution',planning:{parentId:'parent',execution:'direct'},externalRefs:original.get('leaf')!.externalRefs});
    for(const item of after.board.items.filter(item=>original.has(item.id)))expect([item.id,item.createdAt,item.updatedAt]).toEqual([item.id,original.get(item.id)!.createdAt,original.get(item.id)!.updatedAt]);
    const fallback=after.board.items.find(item=>item.title==='Ungrouped')!;expect(fallback.purpose).toBeUndefined();expect(after.board.items.find(item=>item.id==='orphan')!.planning!.parentId).toBe(fallback.id);
    expect(after.workflow).toEqual(before.workflow);await migrateTaskHierarchy(f.store,options);expect(await f.store.read('b')).toEqual(after);
    const oldReference='KBT-1-'+original.get('parent')!.number;expect(await f.service.resolve(oldReference)).toMatchObject({itemId:'parent'});
});
it('keeps decision priority optional, accepts P0, clears it and rejects invalid mutations atomically',async()=>{
    const f=await fixture();await f.run({type:'append-record',record:{id:'d',kind:'decision',title:'Decision',content:'Scope',rationale:'Evidence',itemIds:[],sources:[]}});
    expect((await f.service.record('b','d')).priority).toBeUndefined();
    await f.run({type:'set-record-priority',recordId:'d',priority:0});expect((await f.service.record('b','d')).priority).toBe(0);
    const before=await f.store.read('b');await expect(f.run({type:'set-record-priority',recordId:'d',priority:5 as 0})).rejects.toMatchObject({code:'INVALID_RECORD_PRIORITY'});expect(await f.store.read('b')).toEqual(before);
    await f.run({type:'set-record-priority',recordId:'d',priority:null});expect((await f.service.record('b','d')).priority).toBeUndefined();
});
it('dispatches independent siblings within limits and holds their successor until both are accepted',async()=>{
    const f=await fixture();await f.create('manager');
    const definition=(id:string,dependsOn:string[]=[])=>({id,title:id,responsibility:'Work',acceptance:'Evidence',assignee:{kind:'human' as const,id:'owner'},dependsOn});
    await f.run({type:'publish-plan',plan:{schema:'kanban.plan/1',id:'dag',rootItemId:'manager',revision:1,sealed:true,items:[definition('one'),definition('two'),definition('join',['one','two'])]}});
    expect((await f.service.workflow('b')).ready).toEqual(['one','two']);
    for(const id of ['one','two'])await f.run({type:'prepare-dispatch',itemId:id,dispatchId:'run-'+id});
    const workflow=await f.service.workflow('b');expect(Object.values(workflow.dispatches)).toHaveLength(2);expect(workflow.ready).not.toContain('join');
    await f.run({type:'observe-execution',dispatchId:'run-one',fence:workflow.dispatches['run-one'].fence,outcome:'failed',code:'CHECK_FAILED'});
    expect((await f.service.workflow('b')).ready).not.toContain('join');
});

it('leaves startup migration retryable after a storage failure and logs a safe cause',async()=>{
    const f=await fixture();await f.create('manager');const before=await f.store.read('b'),log=vi.fn();
    const options={actor:{kind:'service' as const,id:'migration'},ungrouped:{title:'Ungrouped',responsibility:'Coordinate',acceptance:'Accepted'},log};
    const failing=vi.spyOn(f.store,'update').mockRejectedValueOnce(Object.assign(Error('PRIVATE_CONTENT'),{code:'ENOSPC'}));
    await expect(migrateTaskHierarchy(f.store,options)).rejects.toMatchObject({code:'ENOSPC'});failing.mockRestore();
    expect(await f.store.read('b')).toEqual(before);expect(log).toHaveBeenCalledWith(expect.objectContaining({stage:'task.hierarchy.migrate',result:'failure',code:'ENOSPC'}));
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_CONTENT');await migrateTaskHierarchy(f.store,options);expect((await f.store.read('b'))!.hierarchyVersion).toBe(1);
});
