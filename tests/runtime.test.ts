import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {assembleKanbanRuntime,coordinateOperation,type KanbanOperationRecord,type KanbanOperationPort} from '../src/runtime/integration';
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
async function fixture() {
    const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());
    const fs=await manager.openFileSystem('/'),diagnostic=vi.fn();
    const options={fs,actor:{kind:'human' as const,id:'owner'},authorize:async()=>{},log:diagnostic};
    const runtime=await assembleKanbanRuntime(options);closes.push(()=>runtime.service.dispose());
    await runtime.service.create({id:'board',title:'Independent',scope:{kind:'system'},members:[{kind:'human',id:'owner',responsibility:'Coordinate',roles:['coordinator','reviewer','worker']}]});
    return {...runtime,options,diagnostic};
}
it('assembles persistent boards, logs, deletion and shutdown without a host framework',async()=>{
    const f=await fixture();let board=await f.service.read('board');
    await f.service.execute(board.id,{operationId:'create-item',expectedRevision:board.revision,command:{type:'create-item',item:{id:'item',title:'First',responsibility:'Act',acceptance:'Done'}}});
    await f.service.scan();
    expect((await f.service.query('board',{view:'all'})).items.map(row=>row.id)).toEqual(['item']);
    const reopened=await assembleKanbanRuntime(f.options);closes.push(()=>reopened.service.dispose());
    expect((await reopened.service.item('board','item')).item.title).toBe('First');
    await reopened.service.quiesce();
    await expect(reopened.service.create({id:'late',title:'Late',scope:{kind:'system'}})).rejects.toMatchObject({code:'SERVICE_STOPPING'});
});
function job():KanbanOperationRecord{return {id:'run',boardId:'board',itemId:'item',action:'external-task',fingerprint:'frozen',phase:'prepared',state:'running',createdAt:1};}
async function operationFixture() {
    const f=await fixture(),record=job(),key='test-operation:run';
    await f.journal.update(key,()=>record);
    const port:KanbanOperationPort<KanbanOperationRecord>={start:vi.fn(async()=>{}),inspect:vi.fn(async()=>({state:'unknown' as const})),validate:vi.fn()};
    return {...f,record,key,port,advance:()=>coordinateOperation({service:f.service,journal:f.journal,key,record,port})};
}
it('recovers a lost reply by inspecting the same operation, never resubmitting',async()=>{
    const f=await operationFixture();
    vi.mocked(f.port.start).mockRejectedValueOnce(Object.assign(new Error('private instruction'),{code:'CONNECTION_LOST'}));
    expect(await f.advance()).toMatchObject({phase:'submitting',state:'unknown',code:'CONNECTION_LOST'});
    await f.advance();await f.advance();
    expect(f.port.start).toHaveBeenCalledTimes(1);expect(f.port.inspect).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.diagnostic.mock.calls)).not.toContain('private instruction');
});
it('accepts results only after adapter validation and prevents duplicate starts',async()=>{
    const f=await operationFixture();
    vi.mocked(f.port.inspect).mockResolvedValue({state:'succeeded',output:{answer:42},executionId:'remote-run'});
    expect(await f.advance()).toMatchObject({phase:'settled',state:'succeeded',sessionId:'remote-run',result:{answer:42}});
    await f.advance();expect(f.port.start).toHaveBeenCalledTimes(1);expect(f.port.validate).toHaveBeenCalledOnce();
});
it('keeps a successful execution unresolved until its output arrives',async()=>{
    const f=await operationFixture();vi.mocked(f.port.inspect).mockResolvedValueOnce({state:'succeeded'});
    expect(await f.advance()).toMatchObject({phase:'submitting',state:'unknown',code:'OPERATION_RESULT_PENDING'});
    vi.mocked(f.port.inspect).mockResolvedValueOnce({state:'succeeded',output:{value:'ready'}});
    expect(await f.advance()).toMatchObject({phase:'settled',state:'succeeded'});expect(f.port.start).toHaveBeenCalledOnce();
});
