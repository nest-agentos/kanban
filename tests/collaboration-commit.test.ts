import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule,SeqKanbanStore} from '../src';
import {KanbanAutomationJournal,commitCollaboration,journalCommand,reserveJournalResource,releaseJournalResource} from '../src/runtime/integration';
const cleanup:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
async function fixture(){
    const {manager}=await createVFS({rootBackend:new MemoryBackend()});cleanup.push(()=>manager.dispose());const fs=await manager.openFileSystem('/');
    const journal=new KanbanAutomationJournal(fs);await journal.open();
    const actor={kind:'human' as const,id:'owner'},service=createKanbanModule({store:await SeqKanbanStore.open(fs),actor,authorize:async()=>{},log(){}});
    await service.create({id:'b',title:'Research',scope:{kind:'system'},members:[{...actor,responsibility:'Coordinate',roles:['coordinator','reviewer','worker']}],policy:{requireEstimate:false}});
    const command={type:'create-item' as const,item:{id:'child',title:'Research child',responsibility:'Study',acceptance:'Evidence'}};
    const input={id:'collaboration',boardId:'b',itemId:'parent',commandKey:'legacy-confirm-key',command,children:[{id:'child',title:'Research child',responsibility:'Study',acceptance:'Evidence',assignee:actor,dependsOn:[],estimate:{complexity:1,workUnits:1,durationMs:1000,confidence:'high' as const}}]};
    return {fs,journal,service,input};
}
it('rolls back all journal rows and board indexes when any related checkpoint is rejected',async()=>{
    const f=await fixture();await expect(f.journal.updateMany([{key:'fix:rollback',change:()=>({boardId:'b'})},{key:'second',change:()=>{throw Error('Rejected');}}])).rejects.toThrow('Rejected');
    expect(await f.journal.get('fix:rollback')).toBeUndefined();expect(await f.journal.get('second')).toBeUndefined();expect(await f.journal.findForBoard('fix:','b',()=>true)).toEqual([]);
});
it('recovers an ACK failure through the original outbox without publishing the domain command twice',async()=>{
    const f=await fixture(),execute=vi.spyOn(f.service,'execute'),deliver=vi.fn(async(_id:string)=>{throw Error('ACK lost');});
    await expect(commitCollaboration(f.service,f.journal,f.input,deliver)).rejects.toThrow('ACK lost');
    expect((await f.service.read('b')).items.map(item=>item.id)).toEqual(['child']);expect(await f.journal.get('decomposition-status:'+JSON.stringify(['b','child']))).toBeDefined();
    expect(await f.journal.get('collaboration-commit:collaboration')).toMatchObject({phase:'committed'});
    const reopened=new KanbanAutomationJournal(f.fs);await reopened.open();deliver.mockResolvedValue(undefined as never);
    await commitCollaboration(f.service,reopened,f.input,deliver);await commitCollaboration(f.service,reopened,f.input,deliver);
    expect(execute).toHaveBeenCalledOnce();expect(deliver.mock.calls.map(row=>row[0])).toEqual(['collaboration','collaboration']);expect(await reopened.get('collaboration-commit:collaboration')).toMatchObject({phase:'delivered'});
});
it('accepts legacy command receipts and rejects changed immutable requests before adding checkpoints',async()=>{
    const f=await fixture();await journalCommand(f.journal,f.service,'b',f.input.commandKey,f.input.command);const execute=vi.spyOn(f.service,'execute');
    await commitCollaboration(f.service,f.journal,f.input);expect(execute).not.toHaveBeenCalled();
    await expect(commitCollaboration(f.service,f.journal,{...f.input,command:{...f.input.command,item:{...f.input.command.item,title:'Changed'}}})).rejects.toMatchObject({code:'COLLABORATION_IDEMPOTENCY_CONFLICT'});
    expect((await f.service.item('b','child')).item.title).toBe('Research child');
});
it('makes reservation races atomic and cannot release a different owner or reuse an identity in another scope',async()=>{
    const f=await fixture(),same=(a:{id:string;scope:string},b:{id:string;scope:string})=>a.scope===b.scope;
    const owners=[{id:'one',scope:'a'},{id:'two',scope:'b'}],result=await Promise.all(owners.map(owner=>reserveJournalResource(f.journal,'shared-resource',owner,async()=>false,same)));
    expect(result.filter(Boolean)).toHaveLength(1);const winner=owners[result.indexOf(true)],loser=owners[result.indexOf(false)];
    await releaseJournalResource(f.journal,'shared-resource',loser,same);expect(await f.journal.get('shared-resource')).toEqual(winner);
    await expect(reserveJournalResource(f.journal,'shared-resource',{...winner,scope:'foreign'},async()=>true,same)).rejects.toMatchObject({code:'RESOURCE_RESERVATION_ID_CONFLICT'});
    await releaseJournalResource(f.journal,'shared-resource',winner,same);expect(await reserveJournalResource(f.journal,'shared-resource',loser,async()=>false,same)).toBe(true);
});

it('resumes a committed coordination repair without requiring a host fix record, and respects pause and restart',async()=>{
    const {resumeCollaborationRepairs}=await import('../src/runtime/integration');const f=await fixture();
    const board={id:'b',automation:{enabled:true},items:[{id:'original',repairPending:{itemId:'repair'}},{id:'repair',status:'completed'}],executionControl:{paused:false}};
    const service={read:async()=>board} as never,resume=vi.fn(async()=>{});
    await f.journal.update('repair-resumption:coordinate',()=>({fixId:'coordinate',commitId:'coordinate',boardId:'b',itemId:'original',done:false}));
    await f.journal.update('collaboration-commit:coordinate',()=>({phase:'prepared'}));await resumeCollaborationRepairs(service,f.journal,()=>true,resume);expect(resume).not.toHaveBeenCalled();
    await f.journal.update('collaboration-commit:coordinate',()=>({phase:'committed'}));await resumeCollaborationRepairs(service,f.journal,()=>true,resume);expect(resume).toHaveBeenCalledOnce();
    board.executionControl.paused=true;await resumeCollaborationRepairs(service,f.journal,()=>true,resume);expect(resume).toHaveBeenCalledOnce();
    board.executionControl.paused=false;const reopened=new KanbanAutomationJournal(f.fs);await reopened.open();await resumeCollaborationRepairs(service,reopened,()=>true,resume);expect(resume.mock.calls[1]).toEqual(resume.mock.calls[0]);
});
