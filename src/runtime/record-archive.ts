import {recordArchiveBlocker} from '../contracts/record-archive';
import {withRecordProgress} from './record-progress';
import type {KanbanRecordPage,KanbanClient,KanbanRecordArchiveRequest,KanbanRecordArchiveResult} from '../contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import {journalCommand} from './journal-command';
import {requireValue} from '../rules';
import {sha256HexSync} from '../utils';
import {safeCode} from './diagnostics';
type Log=(event:{operationId:string;boardId:string;stage:string;result:'success'|'failure';code?:string;count?:number;durationMs:number})=>void;
type Saved={digest:string;results:KanbanRecordArchiveResult['items']};
type ArchiveOne=(board:string,request:{recordId:string;operationId:string;expectedRevision?:number})=>Promise<void>;
export function recordArchival(service:KanbanClient,journal:KanbanAutomationJournal,log:Log,readRecords: (board:string)=>Promise<KanbanRecordPage>=async board=>withRecordProgress(await service.records(board,{kind:'decision',includeArchived:true,limit:200}),board,journal,service)){
    const archive=recordArchiver(service,journal,log,readRecords),batch=recordArchiveBatch(journal,log,archive);
    let stopping=false;const pending=new Set<Promise<unknown>>();
    const track=async<T>(run:()=>Promise<T>):Promise<T>=>{
        requireValue(!stopping,'SERVICE_STOPPING');const work=run();pending.add(work);
        try{return await work;}finally{pending.delete(work);}
    };
    return {archive:(board:string,request:Parameters<ArchiveOne>[1])=>track(()=>archive(board,request)),
        archiveRecords:(board:string,request:KanbanRecordArchiveRequest)=>track(()=>batch(board,request)),
        quiesce:async()=>{stopping=true;await Promise.allSettled([...pending]);}};
}
function recordArchiver(service:KanbanClient,journal:KanbanAutomationJournal,log:Log,readRecords:(board:string)=>Promise<KanbanRecordPage>):ArchiveOne {
    return async(boardId,request)=>{
        const started=Date.now();try{
            requireValue(request&&typeof request.operationId==='string'&&/^[\w-]{1,128}$/.test(request.operationId),'INVALID_RECORD_CONTROL');
            const record=await service.record(boardId,request.recordId);
            if(record.archivedAt!==undefined)return;
            requireValue(request.expectedRevision===undefined||record.revision===request.expectedRevision,'REVISION_CONFLICT');
            await verifyRecordArchive(journal,boardId,request.recordId,readRecords);
            await journalCommand(journal,service,boardId,'record-archive:'+JSON.stringify([boardId,request.recordId,request.operationId]),{type:'archive-record',recordId:request.recordId,recordRevision:record.revision});
            log({operationId:request.operationId,boardId,stage:'record.archive',result:'success',durationMs:Date.now()-started});
        }catch(error){log({operationId:request.operationId,boardId,stage:'record.archive',result:'failure',code:safeCode(error,'RECORD_ARCHIVE_FAILED'),durationMs:Date.now()-started});throw error;}
    };
}
function recordArchiveBatch(journal:KanbanAutomationJournal,log:Log,archive:ArchiveOne){
    return async(boardId:string,request:KanbanRecordArchiveRequest):Promise<KanbanRecordArchiveResult>=>{
        const started=Date.now();
        requireValue(request&&typeof request.operationId==='string'&&/^[\w-]{1,128}$/.test(request.operationId)&&Array.isArray(request.records)&&request.records.length>0&&request.records.length<=50,'INVALID_RECORD_CONTROL');
        requireValue(request.records.every(row=>row&&typeof row.recordId==='string'&&row.recordId.length>0&&Number.isSafeInteger(row.expectedRevision)&&row.expectedRevision>0)&&new Set(request.records.map(row=>row.recordId)).size===request.records.length,'INVALID_RECORD_CONTROL');
        const key='record-archive-batch:'+JSON.stringify([boardId,request.operationId]),digest=sha256HexSync(JSON.stringify(request.records));
        let saved=await journal.update<Saved>(key,old=>{requireValue(!old||old.digest===digest,'IDEMPOTENCY_CONFLICT');return old??{digest,results:[]};});
        for(const row of request.records){
            if(saved.results.some(result=>result.recordId===row.recordId&&result.outcome!=='unknown'))continue;
            let result:KanbanRecordArchiveResult['items'][number];
            try{await archive(boardId,{...row,operationId:sha256HexSync(JSON.stringify([request.operationId,row.recordId]))});result={recordId:row.recordId,outcome:'archived'};}
            catch(error){const code=safeCode(error,'RECORD_ARCHIVE_FAILED');result={recordId:row.recordId,code,outcome:['RECORD_EXECUTION_UNSETTLED','REVISION_CONFLICT','RECORD_NOT_FOUND','RECORD_DELETED','FORBIDDEN','COORDINATOR_REQUIRED','INDEPENDENT_REVIEW_REQUIRED'].includes(code)?'failed':'unknown'};}
            saved=await journal.update<Saved>(key,old=>({...old!,results:[...old!.results.filter(value=>value.recordId!==row.recordId),result]}));
        }
        const code=saved.results.some(row=>row.outcome==='unknown')?'RECORD_ARCHIVE_RESULT_UNKNOWN':saved.results.some(row=>row.outcome==='failed')?'RECORD_ARCHIVE_PARTIAL':undefined;
        log({operationId:request.operationId,boardId,stage:'record.archive.batch',result:code?'failure':'success',code,count:request.records.length,durationMs:Date.now()-started});
        return {operationId:request.operationId,items:saved.results};
    };
}

export async function verifyRecordArchive(journal:KanbanAutomationJournal,boardId:string,recordId:string,readRecords:(board:string)=>Promise<KanbanRecordPage>):Promise<void> {
    const record=(await readRecords(boardId)).items.find(row=>row.id===recordId);requireValue(record,'RECORD_NOT_FOUND');
    const code=recordArchiveBlocker(record);requireValue(!code||code==='RECORD_ARCHIVED',code??'RECORD_EXECUTION_UNSETTLED');
    const runs=await journal.activeRecordRuns(boardId,recordId);
    requireValue(!runs.length,'RECORD_EXECUTION_UNSETTLED');
}
