import {afterEach,expect,it} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {SeqKanbanStore,createKanbanModule,type KanbanCommand,type KanbanWorkPlan} from '../src';
import {KanbanAutomationJournal} from '../src/runtime/automation-journal';
import {createTaskRestart} from '../src/runtime/task-restart';
import {projectKanbanTask} from '../src/contracts';
const closes:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
async function fixture(group=false){
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());const fs=await manager.openFileSystem('/'),store=await SeqKanbanStore.open(fs);
 const service=createKanbanModule({store,actor:{kind:'human',id:'owner'},authorize:async()=>{},verifyOutputs:async()=>true,log(){}});
 await service.create({id:'b',title:'Recovery',scope:{kind:'system'},members:[{kind:'human',id:'owner',responsibility:'Manage',roles:['coordinator','reviewer','worker']},{kind:'human',id:'inspector',responsibility:'Review',roles:['coordinator','reviewer']}],policy:{requireEstimate:false,review:'independent'}});
 const inspector=createKanbanModule({store,actor:{kind:'human',id:'inspector'},authorize:async()=>{},verifyOutputs:async()=>true,log(){}});
 let serial=0;const run=(command:KanbanCommand)=>service.read('b').then(board=>service.execute('b',{operationId:'op-'+ ++serial,expectedRevision:board.revision,command}));
 if(group)await run({type:'create-item',item:{id:'group',title:'Group',responsibility:'Coordinate',acceptance:'Children accepted'},planning:{kind:'task',priority:2,dependencies:[],references:[]}});
 const definition=(id:string,dependsOn:string[]=[])=>({id,title:id,responsibility:'Work',acceptance:'Verified',workType:group?'subtask':'task',assignee:{kind:'human' as const,id:'owner'},dependsOn,outputs:['result']});
 const plan:KanbanWorkPlan={schema:'kanban.plan/1',id:'p',revision:1,sealed:true,...(group?{rootItemId:'group'}:{}),items:[definition('source'),{...definition('verify',['source']),inputs:{result:{fromItemId:'source',output:'result'}}},definition('unrelated')]};await run({type:'publish-plan',plan});
 const output=(label:string)=>({name:'result',ref:label,sha256:'a'.repeat(64),bytes:1});
 const finish=async(item:string,id:string)=>{await run({type:'prepare-dispatch',itemId:item,dispatchId:id});const d=(await service.workflow('b')).dispatches[id];await run({type:'observe-execution',dispatchId:id,fence:d.fence,outcome:'succeeded',outputs:[output(id)]});await inspector.execute('b',{operationId:'review-'+ ++serial,expectedRevision:(await service.read('b')).revision,command:{type:'accept-execution',dispatchId:id,accept:true}});};
 await finish('source','old-source');await run({type:'prepare-dispatch',itemId:'verify',dispatchId:'old-verify'});const d=(await service.workflow('b')).dispatches['old-verify'];await run({type:'observe-execution',dispatchId:d.id,fence:d.fence,outcome:'failed',code:'VERIFICATION_FAILED',executionSessionId:'original-session'});await finish('unrelated','unrelated-run');
 const journal=new KanbanAutomationJournal(fs);await journal.open();return {service:service as any,run,finish,output,journal,definition};
}
it('restarts only reachable tasks after terminal receipts, survives restart and consumes fresh upstream outputs',async()=>{
 const f=await fixture(),restart=createTaskRestart(f),before=await f.service.item('b','unrelated'),history=structuredClone((await f.service.workflow('b')).dispatches);
 const preview=await restart.previewTaskRestart('b','source');expect(preview.affected.map(row=>row.id)).toEqual(['source','verify']);
 const request={operationId:'restart-one',itemId:'source',version:preview.version,confirmed:true};expect(await restart.restartTask('b',request)).toMatchObject({state:'stopping'});
 const control=(await f.service.item('b','verify')).item.control;await f.run({type:'control-receipt',itemId:'verify',controlId:control.id,state:'unknown',code:'CONNECTION_LOST'});
 await restart.scan();expect((await f.service.item('b','source')).item.status).toBe('completed');
 await f.run({type:'control-receipt',itemId:'verify',controlId:control.id,state:'cancelled'});await restart.quiesce();const recovered=createTaskRestart(f);await recovered.scan();
 expect(await recovered.restartTask('b',request)).toMatchObject({state:'restarted'});expect(await f.service.item('b','unrelated')).toEqual(before);
 const board=await f.service.read('b'),workflow=await f.service.workflow('b');expect(workflow.dispatches).toEqual(history);
 expect(projectKanbanTask(board.items.find((row:any)=>row.id==='verify'),workflow,Date.now(),board.items)).toMatchObject({phase:'waiting-dependency',dispatchId:undefined});
 await expect(f.run({type:'continue-execution',previousDispatchId:'old-verify',dispatchId:'stale'})).rejects.toMatchObject({code:'ITEM_NOT_CONTINUABLE'});
 await f.finish('source','new-source');await f.run({type:'prepare-dispatch',itemId:'verify',dispatchId:'new-verify'});
 expect((await f.service.workflow('b')).dispatches['new-verify']).toMatchObject({attempt:2,executionEpoch:'restart-one',inputs:{result:f.output('new-source')}});
 await recovered.quiesce();
});
it('rejects a stale preview and prevents graph mutation or archiving during drain',async()=>{
 const f=await fixture(),runtime=createTaskRestart(f),preview=await runtime.previewTaskRestart('b','source');
 await f.run({type:'request-control',itemId:'verify',controlId:'other-control',action:'cancel'});
 await expect(runtime.restartTask('b',{operationId:'stale',itemId:'source',version:preview.version,confirmed:true})).rejects.toMatchObject({code:'RESTART_PREVIEW_CHANGED'});
 const fresh=await runtime.previewTaskRestart('b','source');await runtime.restartTask('b',{operationId:'fresh',itemId:'source',version:fresh.version,confirmed:true});
 await expect(f.run({type:'archive-items',itemIds:['source'],reason:'Hide'})).rejects.toMatchObject({code:'DEPENDENCY_RESTART_PENDING'});
 await expect(f.run({type:'create-item',item:{id:'new',title:'New',responsibility:'Work',acceptance:'Done'},planning:{kind:'task',priority:2,dependencies:['source'],references:[]}})).rejects.toMatchObject({code:'DEPENDENCY_RESTART_PENDING'});await runtime.quiesce();
});
it('atomically inserts a repair from a group proposal and continues only after formal repair acceptance',async()=>{
 const f=await fixture(true),source=await f.service.item('b','source'),failed=structuredClone((await f.service.workflow('b')).dispatches['old-verify']);
 const target=(await f.service.item('b','verify')).item;
 await f.run({type:'insert-repair-dependency',itemId:'verify',expectedItemRevision:target.revision,plan:{schema:'kanban.plan/1',id:'repair-plan',revision:1,sealed:true,mode:'append',rootItemId:'group',items:[f.definition('repair',['source'])]}});
 expect((await f.service.item('b','repair')).item.planning.parentId).toBe('group');expect((await f.service.item('b','verify')).item.planning.dependencies).toEqual(['source','repair']);
 await expect(f.run({type:'continue-execution',previousDispatchId:'old-verify',dispatchId:'too-soon'})).rejects.toMatchObject({code:'DEPENDENCIES_UNFINISHED'});
 await f.finish('repair','repair-run');await f.run({type:'continue-execution',previousDispatchId:'old-verify',dispatchId:'recheck'});
 expect((await f.service.workflow('b')).dispatches.recheck).toMatchObject({attempt:2,continuation:{previousDispatchId:'old-verify'}});
 expect((await f.service.workflow('b')).dispatches['old-verify']).toEqual(failed);expect(await f.service.item('b','source')).toEqual(source);
});
it('rolls back repair creation when the proposal introduces a dependency cycle',async()=>{
 const f=await fixture(true),target=(await f.service.item('b','verify')).item,before=await f.service.read('b');
 await expect(f.run({type:'insert-repair-dependency',itemId:'verify',expectedItemRevision:target.revision,plan:{schema:'kanban.plan/1',id:'bad-repair',revision:1,sealed:true,mode:'append',rootItemId:'group',items:[f.definition('repair',['verify'])]}})).rejects.toMatchObject({code:'DEPENDENCY_CYCLE'});
 expect(await f.service.read('b')).toEqual(before);
});
