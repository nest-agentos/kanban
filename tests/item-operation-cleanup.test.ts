import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal,finishReviewCleanup,registerReviewCleanup,reviewCleanupKey,type ReviewCleanup} from '@nestos/kanban/integration';
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
it('reports a verified missing review capability instead of waiting forever',async()=>{
 const f=await fixture();f.cleanup.mockRejectedValue(Object.assign(Error('dirty'),{code:'WORKTREE_DIRTY'}));
 f.cleanupReview.mockRejectedValue(Object.assign(Error('no original manager'),{code:'MANAGEMENT_SESSION_NOT_READY',cleanupReviewUnavailable:true}));
 expect(await finishReviewCleanup(f,'board','item','merge')).toBe(false);
 expect(await f.journal.get(reviewCleanupKey('board','item','scope'))).toMatchObject({state:'failed',reviewState:'reviewed',code:'MANAGEMENT_SESSION_NOT_READY'});
});

it('automatically retries a temporary blocker with the same cleanup identity on the next recovery scan',async()=>{
 const f=await fixture(),options={...f,retryCleanup:(code:string)=>code==='WORKTREE_IN_USE'};
 f.cleanup.mockRejectedValueOnce(Object.assign(Error('busy'),{code:'WORKTREE_IN_USE'}));
 expect(await finishReviewCleanup(options,'board','item','merge')).toBe(false);
 const key=reviewCleanupKey('board','item','scope');
 expect(await f.journal.get(key)).toMatchObject({state:'running',code:'WORKTREE_IN_USE'});
 expect(await finishReviewCleanup(options,'board','item','merge')).toBe(false);
 expect(f.cleanup).toHaveBeenCalledOnce();
 await f.journal.update<ReviewCleanup>(key,old=>({...old!,retryAt:Date.now()-1}));
 expect(await finishReviewCleanup({...options},'board','item','merge')).toBe(true);
 expect(f.cleanup.mock.calls[0]).toEqual(f.cleanup.mock.calls[1]);
 expect(f.cleanupReview).not.toHaveBeenCalled();
});

it('settles a previously queued review when the host now verifies cleanup',async()=>{
 const f=await fixture();
 f.cleanup.mockRejectedValueOnce(Object.assign(Error('dirty'),{code:'WORKTREE_DIRTY'}));
 expect(await finishReviewCleanup(f,'board','item','merge')).toBe(false);
 expect(await finishReviewCleanup({...f,retryCleanup:()=>false},'board','item','merge')).toBe(true);
 expect(f.cleanup.mock.calls[0]).toEqual(f.cleanup.mock.calls[1]);
 expect(f.cleanupReview).toHaveBeenCalledOnce();
 expect(await f.journal.get(reviewCleanupKey('board','item','scope'))).toMatchObject({state:'succeeded'});
});

it('records the intent before running cleanup and resumes that intent',async()=>{
 const f=await fixture(),key=reviewCleanupKey('board','item','scope');
 await registerReviewCleanup(f,'board','item','merge');
 const intent=await f.journal.get<ReviewCleanup>(key);
 expect(intent).toMatchObject({state:'running',runId:'merge'});
 expect(f.cleanup).not.toHaveBeenCalled();
 expect(await finishReviewCleanup(f,'board','item','merge')).toBe(true);
 expect(f.cleanup).toHaveBeenCalledWith('board','item',intent!.operationId);
});
