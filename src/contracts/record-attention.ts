import type {KanbanRecordSummary} from './context';
import type {KanbanRecordConversation} from './record-conversation';
import {sha256HexSync} from '../utils';

/** Scope acknowledgement to business changes, never to render or observation time. */
export function recordAttentionFingerprint(record:KanbanRecordSummary,conversations:KanbanRecordConversation[]=[]):string {
    const progress=record.progress;
    const sessions=conversations.filter(row=>row.recordId===record.id).map(row=>[row.id,row.state,row.code,row.lastActivityAt,row.pendingReports?.map(report=>[report.id,report.type])]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
    return sha256HexSync(JSON.stringify([record.id,record.revision,record.executionEpoch,record.updatedAt,progress?.state,progress?.reason,progress?.phase,progress?.itemId,progress?.groupIds,progress?.lastActivityAt,sessions]));
}
