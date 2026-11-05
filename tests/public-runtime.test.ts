import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import * as publicAPI from '../src/runtime';
import {createKanbanRuntime,type KanbanRuntime,type KanbanExecutionAdapter,type KanbanExecutionIntent,type KanbanExecutionHandle,type KanbanExecutionReceipt} from '../src/runtime';
import type {KanbanCommand} from '../src/contracts';
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
async function fixture() {
    const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());
    const fs=await manager.openFileSystem('/'),intents=new Map<string,KanbanExecutionIntent>(),receipts=new Map<string,KanbanExecutionReceipt>();
    const target={system:'external',id:'worker',revision:'1'},coordinator={kind:'human' as const,id:'owner'},worker={kind:'service' as const,id:'runner'};
    let loseWork=false,losePlan=false,malformed=false;
    const adapter:KanbanExecutionAdapter={
        catalog:async()=>({targets:[{reference:target,label:'External'}],coordinator,worker}),
        prepare:vi.fn(async intent=>{intents.set(intent.id,intent);return malformed?{id:''}:{id:'remote-'+intent.id,data:{intentId:intent.id}};}),
        submit:vi.fn(async handle=>{
            const id=(handle.data as {intentId:string}).intentId,intent=intents.get(id)!;
            const receipt:KanbanExecutionReceipt=intent.purpose==='planning'?{outcome:'succeeded',result:{ready:true,dependencies:[],reason:'Prepared'}}:{outcome:'running',executionId:handle.id};
            receipts.set(handle.id,receipt);
            if(intent.purpose==='work'&&loseWork||intent.purpose==='planning'&&losePlan)throw Object.assign(new Error('private context body'),{code:'NETWORK_LOST'});
            return receipt;
        }),inspect:vi.fn(async handle=>losePlan&&intents.get((handle.data as {intentId:string}).intentId)?.purpose==='planning'?{outcome:'unknown'}:receipts.get(handle.id)??{outcome:'unknown'}),
        control:vi.fn(async(handle,command)=>{if(command.action==='cancel'){receipts.set(handle.id,{outcome:'cancelled'});return 'cancelled';}return command.action==='pause'?'paused':'resumed';})};
    const diagnostic=vi.fn(),options={fs,actor:coordinator,authorize:vi.fn(async()=>{}),execution:adapter,log:diagnostic};
    const open=async()=>{const service=await createKanbanRuntime(options);closes.push(()=>service.dispose());return service;};
    const service=await open();
    await service.create({id:'board',title:'Work',scope:{kind:'system'},members:[{...coordinator,responsibility:'Coordinate',roles:['coordinator','reviewer','worker']}],policy:{requireEstimate:false}});
    const command=async(value:KanbanCommand,api:KanbanRuntime=service)=>api.execute('board',{operationId:commandId(),expectedRevision:(await api.read('board')).revision,command:value});
    await command({type:'configure-automation',settings:{enabled:true,autoAccept:false,planner:target,executor:target,coordinator,worker}});
    const item=async(id='task')=>{await command({type:'create-item',item:{id,title:'Task '+id,responsibility:'PRIVATE-'+id,acceptance:'Evidence'}});await command({type:'request-run',itemId:id});};
    return {service,open,options,adapter,intents,receipts,diagnostic,command,item,loseWork:()=>{loseWork=true;},losePlan:()=>{losePlan=true;},malformed:()=>{malformed=true;},revealPlan:()=>{losePlan=false;}};
}
let sequence=0;
function commandId(){return 'command-'+(++sequence);}
function work(f:Awaited<ReturnType<typeof fixture>>){return [...f.intents.values()].filter(intent=>intent.purpose==='work');}
it('exports a single factory and keeps storage and integration internals off the instance',async()=>{
    const f=await fixture();expect(Object.keys(publicAPI)).toEqual(['createKanbanRuntime']);
    for(const name of ['journal','store','workLog','serviceFor','fs','service'])expect(f.service).not.toHaveProperty(name);
    await f.item();await f.service.scan();expect(work(f)).toHaveLength(1);
    const intent=work(f)[0];expect(JSON.stringify(intent).match(/PRIVATE-task/g)).toHaveLength(1);
    expect(intent).not.toHaveProperty('sessionId');expect(intent).not.toHaveProperty('request');
});
it('runs planning and execution through one adapter and owns result persistence and verification',async()=>{
    const f=await fixture();await f.item();await f.service.scan();const intent=work(f)[0];
    f.receipts.set('remote-'+intent.id,{outcome:'succeeded',executionId:'remote-'+intent.id,result:{answer:42}});
    await f.service.scan();expect((await f.service.item('board','task')).item.status).toBe('review');
    expect(await f.service.results('board',intent.id)).toEqual([{reference:expect.objectContaining({name:'result'}),value:{answer:42}}]);
    await f.command({type:'accept-execution',dispatchId:intent.id,accept:true});
    expect((await f.service.item('board','task')).item.status).toBe('completed');
});
it('recovers response loss using the persisted opaque handle without preparing or submitting again',async()=>{
    const f=await fixture();await f.item();f.loseWork();await f.service.scan();
    const id=work(f)[0].id;expect((await f.service.workflow('board')).dispatches[id].outcome).toBe('unknown');
    await f.service.dispose();const reopened=await f.open();await reopened.scan();
    expect(f.adapter.prepare).toHaveBeenCalledTimes(2);expect(f.adapter.submit).toHaveBeenCalledTimes(2);
    expect(f.adapter.inspect).toHaveBeenCalledWith({id:'remote-'+id,data:{intentId:id}});
    expect(JSON.stringify(f.diagnostic.mock.calls)).not.toContain('private context body');
});
it('recovers an uncertain planning submission through the same adapter identity',async()=>{
    const f=await fixture();await f.item();f.losePlan();await f.service.scan();
    expect(f.adapter.submit).toHaveBeenCalledTimes(1);await f.service.dispose();f.revealPlan();const reopened=await f.open();await reopened.scan();
    expect(work(f)).toHaveLength(1);expect(f.adapter.submit).toHaveBeenCalledTimes(2);
});
it('routes cancellation through the stored handle and waits for its authoritative acknowledgement',async()=>{
    const f=await fixture();await f.item();await f.service.scan();const id=work(f)[0].id;
    await f.command({type:'request-control',itemId:'task',controlId:'stop-task',action:'cancel'});await f.service.scan();
    expect(f.adapter.control).toHaveBeenCalledWith({id:'remote-'+id,data:{intentId:id}},expect.objectContaining({action:'cancel'}));
    expect((await f.service.item('board','task')).item.status).toBe('cancelled');
});
it('rejects malformed bindings before an external submission',async()=>{
    const f=await fixture();await f.item();f.malformed();await f.service.scan();
    expect(f.adapter.submit).not.toHaveBeenCalled();expect(await f.service.analysisStatus!('board','task')).toMatchObject({state:'failed',code:'EXECUTION_HANDLE_INVALID'});
});
it('authorizes result reads before resolving artifacts',async()=>{
    const f=await fixture();f.options.authorize.mockRejectedValueOnce(Object.assign(new Error('denied'),{code:'FORBIDDEN'}));
    await expect(f.service.results('board','missing')).rejects.toMatchObject({code:'FORBIDDEN'});
});
it('keeps successful executions unresolved until their results arrive',async()=>{
    const f=await fixture();await f.item();await f.service.scan();const id=work(f)[0].id;
    f.receipts.set('remote-'+id,{outcome:'succeeded'});await f.service.scan();
    expect((await f.service.workflow('board')).dispatches[id]).toMatchObject({outcome:'unknown',code:'EXECUTION_RESULT_PENDING'});
    f.receipts.set('remote-'+id,{outcome:'succeeded',result:null});await f.service.scan();
    expect((await f.service.item('board','task')).item.status).toBe('review');expect(f.adapter.submit).toHaveBeenCalledTimes(2);
});
it('rejects targets outside the adapter catalog before accepting automation settings',async()=>{
    const f=await fixture(),board=await f.service.read('board');
    await expect(f.command({type:'configure-automation',settings:{...board.automation!,executor:{system:'external',id:'forged',revision:'1'}}})).rejects.toMatchObject({code:'AUTOMATION_TARGET_CHANGED'});
    expect(f.adapter.prepare).not.toHaveBeenCalled();
});
it('reports unsupported control without falsely acknowledging cancellation',async()=>{
    const f=await fixture();await f.item();await f.service.scan();delete f.adapter.control;
    await f.command({type:'request-control',itemId:'task',controlId:'unsupported-stop',action:'cancel'});await f.service.scan();
    const {item}=await f.service.item('board','task');expect(item.status).not.toBe('cancelled');expect(item.control).toMatchObject({state:'failed',code:'TASK_CONTROL_UNSUPPORTED'});
});
