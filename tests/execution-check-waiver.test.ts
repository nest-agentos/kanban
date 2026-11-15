import {afterEach,expect,it} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule,SeqKanbanStore} from '../src';
import type {KanbanCommand} from '../src/contracts';
const closes:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of closes.splice(0))await close();});
async function fixture(){
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());
 const store=await SeqKanbanStore.open(await manager.openFileSystem('/'));
 const api=(actor:any)=>createKanbanModule({store,actor,authorize:async()=>{},log(){}}),human=api({kind:'human',id:'admin'}),agent=api({kind:'service',id:'agent'});
 await human.create({id:'b',title:'Board',scope:{kind:'system'},policy:{requireEstimate:false},members:[{kind:'human',id:'admin',roles:['coordinator','reviewer'],responsibility:'Manage'},{kind:'service',id:'agent',roles:['coordinator','worker'],responsibility:'Build'}]});
 let seq=0;const run=(command:KanbanCommand,service=human)=>service.read('b').then(board=>service.execute('b',{operationId:'op-'+ ++seq,expectedRevision:board.revision,command}));
 await run({type:'create-item',item:{id:'root',taskType:'coordination',title:'Root',responsibility:'Manage',acceptance:'Done'}});
 await run({type:'publish-plan',plan:{schema:'kanban.plan/1',id:'plan',revision:1,sealed:true,rootItemId:'root',items:[{id:'task',title:'Work',responsibility:'Implement',acceptance:'Implement and live test',assignee:{kind:'service',id:'agent'},dependsOn:[]}]}});
 await run({type:'prepare-dispatch',itemId:'task',dispatchId:'dispatch'},agent);
 const dispatch=(await human.workflow('b')).dispatches.dispatch;
 await run({type:'observe-execution',dispatchId:'dispatch',fence:dispatch.fence,outcome:'running'});
 const command=async():Promise<KanbanCommand>=>({type:'waive-execution-checks',itemId:'task',dispatchId:'dispatch',expectedItemRevision:(await human.item('b','task')).item.revision,waiver:{id:'waiver',checks:['Live environment test'],reason:'User will verify after delivery'}});
 return {human,agent,run,command,dispatch};
}
it('persists a human waiver without completing execution, resolving errors or changing frozen acceptance',async()=>{
 const f=await fixture();await f.run({type:'report-issue',itemId:'task',issue:{id:'offline',attemptId:'dispatch',type:'error'}});
 const request={operationId:'stable-waiver',expectedRevision:(await f.human.read('b')).revision,command:await f.command()};
 await f.human.execute('b',request);await f.human.execute('b',request);
 const item=(await f.human.item('b','task')).item;
 expect(item.status).toBe('claimed');expect(item.issues?.[0].resolvedBy).toBeUndefined();expect(item.acceptance).toBe('Implement and live test');
 expect(item.executionCheckWaivers).toHaveLength(1);expect(item.executionCheckWaivers?.[0]).toMatchObject({actor:{kind:'human',id:'admin'},dispatchId:'dispatch',checks:['Live environment test']});
 await f.run({type:'resolve-issue',itemId:'task',issueId:'offline',attemptId:'dispatch',resolvedBy:'waiver'});
 await f.run({type:'observe-execution',dispatchId:'dispatch',fence:f.dispatch.fence,outcome:'succeeded'});
 await f.run({type:'accept-execution',dispatchId:'dispatch',accept:true});
 expect((await f.human.item('b','task')).task).toMatchObject({phase:'completed',completion:'mixed'});
 expect((await f.human.query('b',{view:'all'})).items.find(row=>row.id==='task')?.task?.completion).toBe('mixed');
});
it('rejects service self-approval, changed revisions and a different dispatch',async()=>{
 const f=await fixture(),command=await f.command();await expect(f.run(command,f.agent)).rejects.toMatchObject({code:'FORBIDDEN'});
 await expect(f.run({...command,expectedItemRevision:0} as KanbanCommand)).rejects.toMatchObject({code:'REVISION_CONFLICT'});
 await expect(f.run({...command,dispatchId:'foreign'} as KanbanCommand)).rejects.toMatchObject({code:'EXECUTION_NOT_FOUND'});
});
