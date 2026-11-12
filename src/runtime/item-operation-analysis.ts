import {sha256HexSync} from '../utils';
import type {KanbanBoard,KanbanItem,KanbanService} from '../contracts';
import type {KanbanAutomationJournal} from './automation-journal';
export interface AnalysisReviewJob {id:string;boardId:string;itemId:string;scopeId?:string;action:string;phase:'prepared'|'submitting'|'settled';state:string;code?:string;fingerprint:string;operationContext?:unknown;snapshot:{version:string;sourceVersion:string;targetVersion:string}}
interface ReviewSettings {revision:number;invalidatedAnalysis?:{id:string;code:string};jobs:string[]}
export interface ReviewAnalysisPolicy {analysisAction:string;integrationAction:string;refreshCodes:string[];sourceChangedCode:string;targetChangedCode:string;staleCode:string;initialPrerequisites:string[]}
export interface ReviewAnalysisPorts<Job extends AnalysisReviewJob=AnalysisReviewJob> {
 policy:ReviewAnalysisPolicy;
 scopeId?:string;journal:KanbanAutomationJournal;service:Pick<KanbanService,'read'|'item'>;
 adapter:{snapshot(board:KanbanBoard,item:KanbanItem):Promise<{version:string;sourceVersion:string;targetVersion:string}>};
 deliveryPlan?(board:KanbanBoard,item:KanbanItem):Promise<{manualAfter?:string;steps:string[]}>;
 report?(job:Job):Promise<void>;
 log(event:{operationId:string;stage:string;result:'success'|'failure';code?:string;durationMs:number}):void;
}

import {jobKey,reviewKey} from './delivery-policy';
/** Keep the successful analysis as history while revoking its eligibility for a new merge. */
export async function invalidateReviewAnalysis<ReviewJob extends AnalysisReviewJob>(options:ReviewAnalysisPorts<ReviewJob>,board:string,item:string,id:string,code:string,operationId:string):Promise<void> {
    const started=Date.now();
    await options.journal.update<ReviewSettings>(reviewKey(board,item,options.scopeId),old=>{
        if(!old||old.invalidatedAnalysis?.id===id&&old.invalidatedAnalysis.code===code)return old!;
        return {...old,revision:old.revision+1,invalidatedAnalysis:{id,code}};
    });
    options.log({operationId,stage:'operation.merge.revalidate',result:'failure',code,durationMs:Date.now()-started});
}

/** Recheck at external admission as well as when the confirmation request was prepared. */
export async function revalidateMergeAdmission<ReviewJob extends AnalysisReviewJob>(options:ReviewAnalysisPorts<ReviewJob>,job:ReviewJob):Promise<void> {
    if(job.action!==options.policy.integrationAction)return;
    const board=await options.service.read(job.boardId),{item}=await options.service.item(job.boardId,job.itemId);
    const actual=await options.adapter.snapshot(board,item);if(actual.version===job.snapshot.version)return;
    const code=actual.sourceVersion!==job.snapshot.sourceVersion?options.policy.sourceChangedCode:options.policy.targetChangedCode;
    const analysisId=(job.operationContext as {analysisId?:string})?.analysisId;
    if(analysisId)await invalidateReviewAnalysis(options,job.boardId,job.itemId,analysisId,code,job.id);
    await options.journal.update(mergeAdmissionKey(job.id),old=>old??{fingerprint:job.fingerprint,analysisId,code});
    throw Object.assign(new Error(code),{code,executionOutcome:'not-started',retryable:false});
}

const mergeAdmissionKey=(id:string)=>'review-merge-not-started:'+id;


/** Only retired analysis or a proven unstarted merge may receive a new analysis identity. */
export async function prepareAutomaticReanalysis<ReviewJob extends AnalysisReviewJob>(options:ReviewAnalysisPorts<ReviewJob>,boardId:string,itemId:string,previousId?:string):Promise<{revision:string}|undefined> {
    const settings=await options.journal.get<ReviewSettings>(reviewKey(boardId,itemId,options.scopeId));if(!settings)return;
    if(!settings.invalidatedAnalysis){
        const previous=previousId?await options.journal.get<ReviewJob>(jobKey(previousId)):undefined;
        if(previous?.action!==options.policy.analysisAction||previous.phase!=='settled'||previous.code!==options.policy.staleCode)return;
    }
    const rows=await options.journal.getMany<ReviewJob>(settings.jobs.map(jobKey));
    if(rows.some(row=>!row||row.phase!=='settled'||row.boardId!==boardId||row.itemId!==itemId||row.scopeId!==options.scopeId))return;
    const jobs=rows as ReviewJob[],analysis=jobs.filter(row=>row.action===options.policy.analysisAction).at(-1);if(!analysis)return;
    const stale=settings.invalidatedAnalysis?.id===analysis.id&&options.policy.refreshCodes.includes(settings.invalidatedAnalysis.code)
        ||analysis.state==='failed'&&analysis.code===options.policy.staleCode;
    if(!stale||!await unstartedMerge(options,analysis,jobs,previousId))return;
    const board=await options.service.read(boardId),{item}=await options.service.item(boardId,itemId);
    const plan=await options.deliveryPlan?.(board,item);if(plan?.manualAfter)return;
    const actual=await options.adapter.snapshot(board,item);
    const beforeAnalysis=plan?.steps.slice(0,plan.steps.indexOf(options.policy.analysisAction))??options.policy.initialPrerequisites;
    if(actual.sourceVersion!==analysis.snapshot.sourceVersion&&beforeAnalysis.some(action=>jobs.some(job=>job.action===action&&job.state==='succeeded')))return;
    return {revision:sha256HexSync(JSON.stringify([options.scopeId,analysis.id,actual.version])).slice(0,16)};
}
async function unstartedMerge<ReviewJob extends AnalysisReviewJob>(options:ReviewAnalysisPorts<ReviewJob>,analysis:ReviewJob,jobs:ReviewJob[],previousId?:string):Promise<boolean> {
    const previous=previousId?await options.journal.get<ReviewJob>(jobKey(previousId)):undefined;
    const later=jobs.slice(jobs.indexOf(analysis)+1).filter(row=>row.action===options.policy.integrationAction);
    if(later.some(row=>row.id!==previousId))return false;
    if(!previous)return true;
    if(previous.boardId!==analysis.boardId||previous.itemId!==analysis.itemId||previous.scopeId!==analysis.scopeId)return false;
    if(previous.action===options.policy.analysisAction)return previous.id===analysis.id&&previous.phase==='settled'&&previous.state==='failed'&&previous.code===options.policy.staleCode;
    const proof=await options.journal.get<{fingerprint:string;analysisId:string;code:string}>(mergeAdmissionKey(previous.id));
    return previous.phase==='settled'&&previous.state==='failed'&&proof?.fingerprint===previous.fingerprint&&proof.analysisId===analysis.id&&proof.code===previous.code;
}

/** Recover the crash window after admission rejection was recorded but before runner settlement. */
export async function settleRejectedMerge<ReviewJob extends AnalysisReviewJob>(options:ReviewAnalysisPorts<ReviewJob>,job:ReviewJob):Promise<ReviewJob|undefined> {
    if(job.action!==options.policy.integrationAction||job.phase!=='submitting')return;
    const proof=await options.journal.get<{fingerprint:string;analysisId:string;code:string}>(mergeAdmissionKey(job.id));
    if(!proof||proof.fingerprint!==job.fingerprint||proof.analysisId!==(job.operationContext as {analysisId?:string})?.analysisId||!options.policy.refreshCodes.slice(0,2).includes(proof.code))return;
    const saved=await options.journal.update<ReviewJob>(jobKey(job.id),old=>old?.phase==='submitting'&&old.fingerprint===job.fingerprint?{...old,phase:'settled',state:'failed',code:proof.code}:old!);
    options.log({operationId:job.id,stage:'operation.merge.admission-recovery',result:'success',code:proof.code,durationMs:0});
    await options.report?.(saved);return saved;
}
