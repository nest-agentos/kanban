import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {SeqKanbanStore,createKanbanModule,type KanbanCommand} from '../src';
import {KanbanAutomationJournal} from '../src/runtime/automation-journal';
import {createTaskCoordinator} from '../src/runtime/task-coordinator';
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0))await close();});
async function fixture(){
    const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());
    const fs=await manager.openFileSystem('/'),store=await SeqKanbanStore.open(fs),journal=new KanbanAutomationJournal(fs);await journal.open();
    const service=createKanbanModule({store,actor:{kind:'human',id:'admin'},authorize:async()=>{},log(){}});
    await service.create({id:'b',title:'Board',scope:{kind:'system'},policy:{requireEstimate:false},members:[{kind:'human',id:'admin',roles:['coordinator','worker','reviewer'],responsibility:'Manage'}]});
    let serial=0;const command=async(command:KanbanCommand)=>service.execute('b',{operationId:'op-'+ ++serial,expectedRevision:(await service.read('b')).revision,command});
    const target={system:'published',id:'agent',revision:'1'};
    await command({type:'configure-automation',settings:{enabled:true,autoAccept:false,planner:target,executor:target,coordinator:{kind:'human',id:'admin'},worker:{kind:'human',id:'admin'}}});
    await command({type:'create-item',item:{id:'group',title:'Group',responsibility:'Coordinate',acceptance:'Accepted'}});
    await command({type:'publish-plan',plan:{schema:'kanban.plan/1',id:'initial',revision:1,sealed:true,coordination:true,rootItemId:'group',items:[{id:'child',title:'Child',responsibility:'Build',acceptance:'Verify',workType:'subtask',assignee:{kind:'human',id:'admin'},dependsOn:[]}]}});
    const prepare=vi.fn(async()=>({stable:'request'})),start=vi.fn(async()=>{}),inspect=vi.fn(async()=>({state:'running' as 'running'|'succeeded',executionId:'original-session',output:undefined as unknown}));
    const options={service,journal,prepare,port:{start,inspect}};
    const tick=async()=>createTaskCoordinator(options)(await service.read('b'),()=>true);
    return {service,journal,command,prepare,start,inspect,tick};
}
it('coalesces unchanged state, survives restart and never resubmits a running coordination operation',async()=>{
    const f=await fixture();await f.tick();expect(f.prepare).not.toHaveBeenCalled();
    await f.command({type:'report-analysis',itemId:'child',operationId:'normal-progress',status:{itemId:'child',state:'analyzing'}});await f.tick();expect(f.prepare).not.toHaveBeenCalled();
    await f.command({type:'report-analysis',itemId:'child',operationId:'question',status:{itemId:'child',state:'clarification',reason:'Need input'}});
    await f.tick();await f.tick();expect(f.prepare).toHaveBeenCalledOnce();expect(f.start).toHaveBeenCalledOnce();
    f.inspect.mockResolvedValue({state:'succeeded',executionId:'original-session',output:{ready:true}});
    await f.tick();await f.tick();expect(f.start).toHaveBeenCalledOnce();
    await f.command({type:'report-analysis',itemId:'child',operationId:'resolved',status:{itemId:'child',state:'ready'}});
    await f.tick();expect(f.start).toHaveBeenCalledOnce();
});
it('defers a busy original session and retries preparation without submitting a replacement',async()=>{
    const f=await fixture();await f.tick();
    await f.command({type:'report-analysis',itemId:'child',operationId:'failure',status:{itemId:'child',state:'failed',code:'CHECK_FAILED'}});
    f.prepare.mockRejectedValueOnce(Object.assign(new Error('busy'),{code:'CONTINUATION_IN_USE'}));
    await f.tick();expect(f.start).not.toHaveBeenCalled();await f.tick();expect(f.start).toHaveBeenCalledOnce();
    const board=await f.service.read('b');await createTaskCoordinator({service:f.service,journal:f.journal,prepare:f.prepare,port:{start:f.start,inspect:f.inspect}})(board,()=>false);
    expect(f.start).toHaveBeenCalledOnce();
});
it('observes admitted work while paused and defers further state events until resume',async()=>{
    const f=await fixture();await f.tick();
    await f.command({type:'report-analysis',itemId:'child',operationId:'q',status:{itemId:'child',state:'clarification',reason:'Question'}});await f.tick();
    await f.command({type:'request-control',itemId:'group',controlId:'pause',action:'pause'});
    await f.command({type:'control-receipt',itemId:'group',controlId:'pause',state:'paused'});
    f.inspect.mockResolvedValue({state:'succeeded',executionId:'original-session',output:{ready:true}});
    await f.command({type:'report-analysis',itemId:'child',operationId:'a',status:{itemId:'child',state:'failed',code:'CHECK_FAILED'}});await f.tick();
    expect(f.start).toHaveBeenCalledOnce();expect(f.inspect.mock.calls.length).toBeGreaterThan(1);
    await f.command({type:'request-control',itemId:'group',controlId:'resume',action:'resume'});
    await f.command({type:'control-receipt',itemId:'group',controlId:'resume',state:'resumed'});await f.tick();expect(f.start).toHaveBeenCalledTimes(2);
});
