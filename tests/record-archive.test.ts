import {recordArchival} from '../src/runtime/record-archive';
import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {assembleKanbanRuntime} from '../src/runtime/runtime';
import {recordArchiveBlocker,type KanbanCommand} from '../src/contracts';
import {applyRecord} from '../src/project-records';
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
async function fixture(finalization=false){
    const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());
    const log=vi.fn(),runtime=await assembleKanbanRuntime({fs:await manager.openFileSystem('/'),actor:{kind:'human',id:'owner'},authorize:async()=>{},log,extensions:()=>finalization?[{projectRecords:async(_board,page)=>({...page,items:page.items.map(record=>({...record,progress:{state:'needs-action',lastActivityAt:1,followUps:[{boardId:'b',itemId:'task',state:'blocked',phase:'cleanup'}]}}))})}]:[]});
    const service=runtime.service;closes.push(()=>service.dispose());
    await service.create({id:'b',title:'Board',scope:{kind:'system'},members:[{kind:'human',id:'owner',roles:['coordinator','reviewer','worker'],responsibility:'Manage'}],policy:{requireEstimate:false}});
    let serial=0;const command=async(command:KanbanCommand)=>service.execute('b',{operationId:'op-'+ ++serial,expectedRevision:(await service.read('b')).revision,command});
    for(const id of ['done','draft'])await command({type:'append-record',record:{id,kind:'decision',title:id,content:'Private scope',rationale:'Done',itemIds:[],sources:[]}});
    await command({type:'review-record',recordId:'done',accept:false});
    return {service,journal:runtime.journal,command,log,serviceFor:runtime.serviceFor};
}
it('archives settled records without cancellation or resource disposal and retains explicit queries',async()=>{
    const f=await fixture(),before=await f.service.record('b','done');
    const request={operationId:'batch',records:[{recordId:'done',expectedRevision:before.revision},{recordId:'draft',expectedRevision:1}]};
    const result=await f.service.archiveRecords!('b',request);
    expect(result.items).toEqual([{recordId:'done',outcome:'archived'},{recordId:'draft',outcome:'failed',code:'RECORD_EXECUTION_UNSETTLED'}]);
    expect(await f.service.record('b','done')).toMatchObject({status:'rejected',archivedAt:expect.any(Number),content:before.content,sources:before.sources});
    expect((await f.service.records('b')).items.map(row=>row.id)).toEqual(['draft']);
    expect((await f.service.records('b',{includeArchived:true})).items.map(row=>row.id).sort()).toEqual(['done','draft']);
    expect(await f.journal.get('record-control:'+JSON.stringify(['b','done']))).toBeUndefined();
    expect(await f.service.archiveRecords!('b',request)).toEqual(result);
    await expect(f.service.archiveRecords!('b',{...request,records:request.records.slice(0,1)})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('Private scope');
});
it('rejects active runtime work and stale record revisions through both archive entry points',async()=>{
    const f=await fixture(),record=await f.service.record('b','done');
    await expect(f.service.controlRecord!('b',{recordId:'done',operationId:'stale',action:'archive',expectedRevision:0})).rejects.toMatchObject({code:'REVISION_CONFLICT'});
    await f.journal.update('record-runs:b',()=>[{recordId:'done',state:'running',record:{executionEpoch:'old'}}]);
    await expect(f.service.controlRecord!('b',{recordId:'done',operationId:'running',action:'archive',expectedRevision:record.revision})).rejects.toMatchObject({code:'RECORD_EXECUTION_UNSETTLED'});
    await expect(f.command({type:'archive-record',recordId:'done'})).rejects.toMatchObject({code:'RECORD_EXECUTION_UNSETTLED'});
    expect((await f.service.record('b','done')).archivedAt).toBeUndefined();
});
it.each(['running','waiting','needs-action','checking','cancelling'])('blocks archive availability for %s',state=>{
    expect(recordArchiveBlocker({status:'confirmed',progress:{state,lastActivityAt:1} as any})).toBe('RECORD_EXECUTION_UNSETTLED');
});
it('keeps unfinished finalization and descendants visible despite settled parent metadata',()=>{
    expect(recordArchiveBlocker({status:'confirmed',progress:{state:'completed',lastActivityAt:1,followUps:[{state:'blocked'} as any]}})).toBe('RECORD_EXECUTION_UNSETTLED');
    const parent={id:'parent',status:'completed'},child={id:'child',status:'open',planning:{parentId:'parent'}};
    const record={id:'decision',kind:'decision',status:'confirmed',itemIds:['parent'],revision:1};
    const state={board:{items:[parent,child],members:[{kind:'human',id:'owner',roles:['reviewer']}]},records:[record]} as any;
    expect(()=>applyRecord(state,{type:'archive-record',recordId:'decision'},{kind:'human',id:'owner'},1)).toThrow('RECORD_EXECUTION_UNSETTLED');
    child.status='completed';applyRecord(state,{type:'archive-record',recordId:'decision'},{kind:'human',id:'owner'},2);
    expect(state.board.items).toEqual([parent,child]);expect(state.archiveIndex).toBeUndefined();expect(record).toMatchObject({status:'confirmed',archivedAt:2});
});

it('archives completed cross-board work without requiring local task links or changing target resources',async()=>{
    const f=await fixture();await f.command({type:'append-record',record:{id:'cross',kind:'decision',title:'Cross',content:'Scope',rationale:'Done',itemIds:[],sources:[]}});
    await f.command({type:'review-record',recordId:'cross',accept:true});
    await f.service.create({id:'target',title:'Target',scope:{kind:'system'},members:[{kind:'human',id:'owner',roles:['worker','reviewer'],responsibility:'Work'},{kind:'human',id:'reviewer',roles:['reviewer'],responsibility:'Review'}],policy:{requireEstimate:false}});
    let serial=0;const target=async(command:KanbanCommand)=>f.service.execute('target',{operationId:'target-'+ ++serial,expectedRevision:(await f.service.read('target')).revision,command});
    await target({type:'create-item',item:{id:'task',title:'Target task',responsibility:'Work',acceptance:'Done'},stage:'open'});
    if(!(await f.service.item('target','task')).item.owner)await target({type:'claim',itemId:'task'});
    const item=(await f.service.item('target','task')).item;
    await target({type:'submit',itemId:'task',token:item.owner!.token,resultRef:'verified'});
    await f.serviceFor({kind:'human',id:'reviewer'}).execute('target',{operationId:'review-target',expectedRevision:(await f.service.read('target')).revision,command:{type:'review',itemId:'task',accept:true}});
    const record=await f.service.record('b','cross'),before=await f.service.item('target','task');
    await f.journal.update('record-runs:b',()=>[{id:'cross-run',recordId:'cross',recordRevision:record.revision,record:{executionEpoch:record.executionEpoch},boardId:'target',rootItemId:'task',itemIds:['task'],state:'completed',createdAt:1,updatedAt:2}]);
    await f.service.controlRecord!('b',{recordId:'cross',operationId:'archive-cross',action:'archive',expectedRevision:record.revision});
    expect(await f.service.record('b','cross')).toMatchObject({status:'confirmed',archivedAt:expect.any(Number),itemIds:[]});
    expect(await f.service.item('target','task')).toEqual(before);
});

it('checks required finalization through the runtime projection before archiving',async()=>{
    const f=await fixture(true);
    await expect(f.service.controlRecord!('b',{recordId:'done',operationId:'archive-pending',action:'archive'})).rejects.toMatchObject({code:'RECORD_EXECUTION_UNSETTLED'});
    expect((await f.service.record('b','done')).archivedAt).toBeUndefined();
});
it('reconciles a lost archive acknowledgement using the original batch without repeating disposal or cancellation',async()=>{
    const f=await fixture(),base=f.serviceFor({kind:'human',id:'owner'}),execute=vi.fn(async(...args:Parameters<typeof base.execute>)=>{
        await base.execute(...args);throw Object.assign(new Error('Lost response'),{code:'EIO'});
    });
    const archival=recordArchival({...f.service,execute},f.journal,f.log),record=await f.service.record('b','done');
    const request={operationId:'lost-ack',records:[{recordId:'done',expectedRevision:record.revision}]};
    expect((await archival.archiveRecords('b',request)).items).toEqual([{recordId:'done',outcome:'unknown',code:'EIO'}]);
    expect((await archival.archiveRecords('b',request)).items).toEqual([{recordId:'done',outcome:'archived'}]);
    expect(execute).toHaveBeenCalledOnce();
    await expect(archival.archiveRecords('b',{operationId:'invalid',records:[null]} as any)).rejects.toMatchObject({code:'INVALID_RECORD_CONTROL'});
});

it('drains accepted batches before shutdown and refuses new archive requests during quiescence',async()=>{
    const f=await fixture();let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
    const read=vi.fn(async(board:string)=>{await barrier;return f.service.records(board,{includeArchived:true,limit:200});});
    const archival=recordArchival(f.service,f.journal,f.log,read),record=await f.service.record('b','done');
    const request={operationId:'drain',records:[{recordId:'done',expectedRevision:record.revision}]};
    const work=archival.archiveRecords('b',request);await vi.waitFor(()=>expect(read).toHaveBeenCalledOnce());
    let closed=false;const closing=archival.quiesce().then(()=>{closed=true;});
    await expect(archival.archiveRecords('b',{...request,operationId:'late'})).rejects.toMatchObject({code:'SERVICE_STOPPING'});
    expect(closed).toBe(false);release();expect((await work).items[0].outcome).toBe('archived');await closing;expect(closed).toBe(true);
});
