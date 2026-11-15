import type {KanbanRecordSummary} from './context';
/** Archival changes visibility only; uncertainty or unfinished work must remain visible. */
export function recordArchiveBlocker(record:Pick<KanbanRecordSummary,'status'|'archivedAt'|'progress'>&{itemIds?:readonly string[]}):string|undefined {
    if(record.archivedAt!==undefined)return 'RECORD_ARCHIVED';
    const progress=record.progress;
    if(progress?.followUps?.length)return 'RECORD_EXECUTION_UNSETTLED';
    if(progress?.tasks&&Object.values(progress.tasks).some(tasks=>tasks.completed+tasks.cancelled<tasks.total))return 'RECORD_EXECUTION_UNSETTLED';
    if(record.itemIds?.length===0&&progress?.startedAt===undefined&&!progress?.phase&&!progress?.groupIds?.length
        &&!Object.values(progress?.tasks??{}).some(tasks=>tasks.total>0)
        &&['draft','confirmed'].includes(record.status)&&(!progress||['awaiting-execution','confirm-decision'].includes(progress.reason??'')))return;
    if(['cancelled','rejected','superseded'].includes(record.status)||record.status==='confirmed'&&progress?.state==='completed')return;
    return 'RECORD_EXECUTION_UNSETTLED';
}

export interface KanbanRecordArchiveRequest {operationId:string;records:Array<{recordId:string;expectedRevision:number}>}
export interface KanbanRecordArchiveResult {operationId:string;items:Array<{recordId:string;outcome:'archived'|'failed'|'unknown';code?:string}>}
