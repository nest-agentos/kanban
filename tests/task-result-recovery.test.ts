import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal,registerTaskResultRecovery,resumeTaskResultRecovery,type TaskResultRecoveryPorts} from '../src/runtime/integration';
const closes:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of closes.splice(0))await close();});
async function fixture(){
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());const journal=new KanbanAutomationJournal(await manager.openFileSystem('/'));await journal.open();
 const item={id:'item',status:'backlog'},board={id:'board',automation:{enabled:true},items:[item]},dispatch={id:'original',itemId:'item',attempt:1,outcome:'failed'};
 const recover=vi.fn(async()=>({operationId:'recovery',state:'accepted' as const})),authorized=vi.fn(async()=>true),inspect=vi.fn(async()=>({revision:'revision',canRetry:true}));
 const ports={journal,service:{read:async()=>board,workflow:async()=>({dispatches:{original:dispatch}})},active:()=>true,authorized,inspect,recover,log:vi.fn()} as unknown as TaskResultRecoveryPorts;
 const candidate={boardId:'board',itemId:'item',dispatchId:'original',resultId:'formal-result'};
 await registerTaskResultRecovery(journal,candidate);return {journal,item,board,dispatch,recover,authorized,inspect,ports,candidate};
}
it('admits one stable continuation and retires its candidate without rewriting failed history',async()=>{
 const f=await fixture();await registerTaskResultRecovery(f.journal,f.candidate);await resumeTaskResultRecovery(f.ports);
 expect(f.recover).toHaveBeenCalledWith('board',{operationId:expect.stringMatching(/^completed-result-/),itemId:'item',expectedRevision:'revision',action:'retry'});
 expect(f.dispatch.outcome).toBe('failed');expect(await f.journal.get('task-recovery-results')).toEqual([]);
 await registerTaskResultRecovery(f.journal,f.candidate);await resumeTaskResultRecovery(f.ports);expect(f.recover).toHaveBeenCalledOnce();
});
it.each(['running','unknown'] as const)('never retries an unsettled %s dispatch even if host readiness is positive',async outcome=>{
 const f=await fixture();f.dispatch.outcome=outcome;await resumeTaskResultRecovery(f.ports);expect(f.recover).not.toHaveBeenCalled();expect(f.inspect).not.toHaveBeenCalled();
});
it('respects pause, revoked automatic authority, and missing retained-result readiness',async()=>{
 const f=await fixture();(f.board as any).executionControl={paused:true};await resumeTaskResultRecovery(f.ports);expect(f.recover).not.toHaveBeenCalled();
 (f.board as any).executionControl={paused:false};f.authorized.mockResolvedValue(false);await resumeTaskResultRecovery(f.ports);expect(f.recover).not.toHaveBeenCalled();
 f.authorized.mockResolvedValue(true);f.inspect.mockResolvedValue({revision:'revision',canRetry:false});await resumeTaskResultRecovery(f.ports);expect(f.recover).not.toHaveBeenCalled();
});
it.each(['completed','review','cancelled'])('retires a %s task candidate without scanning its history again',async status=>{
 const f=await fixture();f.item.status=status;await resumeTaskResultRecovery(f.ports);expect(await f.journal.get('task-recovery-results')).toEqual([]);expect(f.recover).not.toHaveBeenCalled();
 await registerTaskResultRecovery(f.journal,f.candidate);await resumeTaskResultRecovery(f.ports);expect(f.authorized).not.toHaveBeenCalled();
});
