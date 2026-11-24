import {sha256HexSync} from '../utils';
import {safeCode} from './diagnostics';
import type {KanbanAutomationJournal} from './automation-journal';
export interface ReviewCleanupPorts {scopeId?:string;retryCleanup?(code:string):boolean;journal:KanbanAutomationJournal;cleanup?(board:string,item:string,id:string):Promise<boolean>;cleanupReview?(input:ReviewCleanup&{boardId:string;itemId:string;scopeId?:string}):Promise<void>;log(event:{operationId:string;stage:string;result:'success'|'failure';code?:string;durationMs:number}):void}
export interface ReviewCleanup {runId:string;operationId:string;attempt:number;state:'running'|'succeeded'|'failed';code?:string;retryFresh?:boolean;retryAt?:number;reviewState?:'pending'|'reviewed';reviewCode?:string;reviewOperationId?:string}
export const reviewCleanupKey=(board:string,item:string,scopeId?:string)=>'review-cleanup:'+JSON.stringify(scopeId?[board,item,scopeId]:[board,item]);
/** Cleanup is owned by the successful delivery, not by a view or an automatic scan ID. */
export async function finishReviewCleanup(options:ReviewCleanupPorts,board:string,item:string,runId:string,retry=false):Promise<boolean> {
    if(!options.cleanup)return true;
    const key=reviewCleanupKey(board,item,options.scopeId),previous=await options.journal.get<ReviewCleanup>(key);
    if(previous?.runId===runId&&previous.state==='succeeded')return true;
    if(previous?.runId===runId&&previous.reviewState==='pending'){
        if(options.retryCleanup&&await recheckPending(options,key,board,item,previous))return true;
        await submitReview(options,key,{...previous,boardId:board,itemId:item,scopeId:options.scopeId});return false;
    }
    if(previous?.runId===runId&&!retry&&previous.retryAt&&previous.retryAt>Date.now())return false;
    if(previous?.runId===runId&&previous.state==='failed'&&!retry)return false;
    const attempt=previous?.runId===runId?previous.attempt+(retry&&previous.retryFresh?1:0):0;
    const operationId=previous?.runId===runId&&previous.attempt===attempt?previous.operationId:cleanupId(board,item,runId,attempt);
    await options.journal.update<ReviewCleanup>(key,()=>({runId,operationId,attempt,state:'running',...(previous?.reviewState==='reviewed'?{reviewState:'reviewed' as const,reviewOperationId:previous.reviewOperationId??previous.operationId}:{})}));
    const started=Date.now();
    try {
        const done=await options.cleanup(board,item,operationId);
        await options.journal.update<ReviewCleanup>(key,old=>({...old!,...(done?{state:'succeeded'}:{retryAt:Date.now()+15_000,code:'WORKTREE_CLEANUP_UNCONFIRMED'})}));
        options.log({operationId,stage:'operation.cleanup',result:done?'success':'failure',code:done?undefined:'WORKTREE_CLEANUP_UNCONFIRMED',durationMs:Date.now()-started});return done;
    } catch(error){
        await recordCleanupFailure(options,key,board,item,operationId,previous,error,started);return false;
    }
}

async function recordCleanupFailure(options:ReviewCleanupPorts,key:string,board:string,item:string,operationId:string,previous:ReviewCleanup|undefined,error:unknown,started:number):Promise<void>{
    const code=safeCode(error,'OPERATION_CLEANUP_FAILED');
    options.log({operationId,stage:'operation.cleanup',result:'failure',code,durationMs:Date.now()-started});
    if(options.retryCleanup?.(code)){
        await options.journal.update<ReviewCleanup>(key,old=>({...old!,code,retryAt:Date.now()+15_000}));return;
    }
    if(options.cleanupReview&&previous?.reviewState!=='reviewed'){
        const review=await options.journal.update<ReviewCleanup>(key,old=>({...old!,state:'running',code:undefined,reviewState:'pending',reviewCode:code}));
        await submitReview(options,key,{...review,boardId:board,itemId:item,scopeId:options.scopeId});return;
    }
    const failure=error as {cleanupPrecondition?:boolean;outcome?:string};
    await options.journal.update<ReviewCleanup>(key,old=>({...old!,state:'failed',code,retryFresh:failure?.cleanupPrecondition===true||failure?.outcome==='not-committed'}));
}

const cleanupId=(board:string,item:string,runId:string,attempt:number)=>'review-cleanup-'+sha256HexSync(JSON.stringify([board,item,runId,attempt])).slice(0,40);

export async function registerReviewCleanup(options:ReviewCleanupPorts,board:string,item:string,runId:string):Promise<void>{
    if(!options.cleanup)return;
    await options.journal.update<ReviewCleanup>(reviewCleanupKey(board,item,options.scopeId),old=>old?.runId===runId?old:
        {runId,operationId:cleanupId(board,item,runId,0),attempt:0,state:'running'});
}

async function recheckPending(options:ReviewCleanupPorts,key:string,board:string,item:string,previous:ReviewCleanup):Promise<boolean>{
    if(previous.retryAt&&previous.retryAt>Date.now())return false;
    const started=Date.now(),operationId=previous.operationId;
    try{
        if(!await options.cleanup!(board,item,operationId))throw Object.assign(Error('Cleanup result pending'),{code:'WORKTREE_CLEANUP_UNCONFIRMED'});
        await options.journal.update<ReviewCleanup>(key,old=>old?.operationId===operationId?{...old,state:'succeeded',code:undefined,retryAt:undefined}:old!);
        options.log({operationId,stage:'operation.cleanup.recheck',result:'success',durationMs:Date.now()-started});return true;
    }catch(error){
        const code=safeCode(error,'OPERATION_CLEANUP_FAILED');
        await options.journal.update<ReviewCleanup>(key,old=>old?.operationId===operationId&&old.state==='running'?{...old,retryAt:Date.now()+15_000}:old!);
        options.log({operationId,stage:'operation.cleanup.recheck',result:'failure',code,durationMs:Date.now()-started});return false;
    }
}

async function submitReview(options:ReviewCleanupPorts,key:string,input:ReviewCleanup&{boardId:string;itemId:string;scopeId?:string}):Promise<void>{
 const started=Date.now();
 try{await options.cleanupReview?.(input);options.log({operationId:input.operationId,stage:'operation.cleanup.review.submit',result:'success',durationMs:Date.now()-started});}
 catch(error){
  const code=safeCode(error,'CLEANUP_REVIEW_UNAVAILABLE');
  options.log({operationId:input.operationId,stage:'operation.cleanup.review.submit',result:'failure',code,durationMs:Date.now()-started});
  if(!(error as {cleanupReviewUnavailable?:boolean})?.cleanupReviewUnavailable)throw error;
  await options.journal.update<ReviewCleanup>(key,old=>old?.state==='succeeded'?old:{...old!,state:'failed',reviewState:'reviewed',code});
 }
}
