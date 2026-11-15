import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal,finishReviewCleanup,reviewCleanupKey,type ReviewCleanup} from '@nestos/kanban/integration';
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0))await close();});
async function fixture(){
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());
 const journal=new KanbanAutomationJournal(await manager.openFileSystem('/'));await journal.open();
 const cleanup=vi.fn(async()=>true),cleanupReview=vi.fn(async()=>{}),log=vi.fn();
 return {journal,cleanup,cleanupReview,log,scopeId:'scope'};
}
it('keeps failed mechanical cleanup pending until the original manager attempts it',async()=>{
 const f=await fixture();f.cleanup.mockRejectedValue(Object.assign(Error('dirty'),{code:'WORKTREE_DIRTY'}));
 expect(await finishReviewCleanup(f,'board','item','merge')).toBe(false);
 const key=reviewCleanupKey('board','item','scope'),pending=await f.journal.get<ReviewCleanup>(key);
 expect(pending).toMatchObject({state:'running',reviewState:'pending',reviewCode:'WORKTREE_DIRTY'});
 await finishReviewCleanup(f,'board','item','merge');expect(f.cleanup).toHaveBeenCalledOnce();
 expect(f.cleanupReview.mock.calls[0]).toEqual(f.cleanupReview.mock.calls[1]);
 await f.journal.update<ReviewCleanup>(key,old=>({...old!,reviewState:'reviewed'}));
 await finishReviewCleanup(f,'board','item','merge');
 expect(await f.journal.get(key)).toMatchObject({state:'failed',code:'WORKTREE_DIRTY',reviewState:'reviewed',reviewOperationId:pending!.operationId});
 expect(f.cleanupReview).toHaveBeenCalledTimes(2);
});
it('records success only when the host cleanup actually succeeds after review',async()=>{
 const f=await fixture();f.cleanup.mockRejectedValueOnce(Object.assign(Error('dirty'),{code:'WORKTREE_DIRTY'}));
 await finishReviewCleanup(f,'board','item','merge');const key=reviewCleanupKey('board','item','scope');
 await f.journal.update<ReviewCleanup>(key,old=>({...old!,reviewState:'reviewed'}));
 expect(await finishReviewCleanup(f,'board','item','merge')).toBe(true);
 expect(await f.journal.get(key)).toMatchObject({state:'succeeded',reviewState:'reviewed'});
 await finishReviewCleanup(f,'board','item','merge');expect(f.cleanup).toHaveBeenCalledTimes(2);
});
it('retains the pending review and stable identity when queue acknowledgement is unavailable',async()=>{
 const f=await fixture();f.cleanup.mockRejectedValue(Object.assign(Error('dirty'),{code:'WORKTREE_DIRTY'}));
 f.cleanupReview.mockRejectedValueOnce(Object.assign(Error('offline'),{code:'EIO'}));
 await expect(finishReviewCleanup(f,'board','item','merge')).rejects.toMatchObject({code:'EIO'});
 await finishReviewCleanup(f,'board','item','merge');expect(f.cleanup).toHaveBeenCalledOnce();
 expect(f.cleanupReview.mock.calls[0]).toEqual(f.cleanupReview.mock.calls[1]);
 expect(await f.journal.get(reviewCleanupKey('board','item','scope'))).toMatchObject({state:'running',reviewState:'pending'});
});
