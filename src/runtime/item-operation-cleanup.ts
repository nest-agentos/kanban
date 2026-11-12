import {sha256HexSync} from '../utils';
import {safeCode} from './diagnostics';
import type {KanbanAutomationJournal} from './automation-journal';
export interface ReviewCleanupPorts {scopeId?:string;journal:KanbanAutomationJournal;cleanup?(board:string,item:string,id:string):Promise<boolean>;log(event:{operationId:string;stage:string;result:'success'|'failure';code?:string;durationMs:number}):void}
export interface ReviewCleanup {runId:string;operationId:string;attempt:number;state:'running'|'succeeded'|'failed';code?:string;retryFresh?:boolean}
export const reviewCleanupKey=(board:string,item:string,scopeId?:string)=>'review-cleanup:'+JSON.stringify(scopeId?[board,item,scopeId]:[board,item]);
/** Cleanup is owned by the successful delivery, not by a view or an automatic scan ID. */
export async function finishReviewCleanup(options:ReviewCleanupPorts,board:string,item:string,runId:string,retry=false):Promise<boolean> {
    if(!options.cleanup)return true;
    const key=reviewCleanupKey(board,item,options.scopeId),previous=await options.journal.get<ReviewCleanup>(key);
    if(previous?.runId===runId&&previous.state==='succeeded')return true;
    if(previous?.runId===runId&&previous.state==='failed'&&!retry)return false;
    const attempt=previous?.runId===runId?previous.attempt+(retry&&previous.retryFresh?1:0):0;
    const operationId='review-cleanup-'+sha256HexSync(JSON.stringify([board,item,runId,attempt])).slice(0,40);
    await options.journal.update<ReviewCleanup>(key,()=>({runId,operationId,attempt,state:'running'}));
    const started=Date.now();
    try {
        const done=await options.cleanup(board,item,operationId);
        if(done)await options.journal.update<ReviewCleanup>(key,old=>({...old!,state:'succeeded'}));
        options.log({operationId,stage:'operation.cleanup',result:'success',durationMs:Date.now()-started});return done;
    } catch(error){
        const code=safeCode(error,'OPERATION_CLEANUP_FAILED');
        await options.journal.update<ReviewCleanup>(key,old=>({...old!,state:'failed',code,retryFresh:(error as {cleanupPrecondition?:boolean;outcome?:string})?.cleanupPrecondition===true||(error as {outcome?:string})?.outcome==='not-committed'}));
        options.log({operationId,stage:'operation.cleanup',result:'failure',code,durationMs:Date.now()-started});return false;
    }
}
