import type {KanbanRecordProgress} from './context';
import type {KanbanDecisionRow as DecisionTableRow} from './decision-page';
import {recordAttentionFingerprint,conversationAttentionFingerprint} from './record-attention';

/** Conversation progress supplements business facts and never proves delivery completion. */
export function decisionRowState(row:DecisionTableRow):KanbanRecordProgress {
    const value=row.value,conversation=row.kind==='conversation'?row.value:row.conversation;
    const times=[value.createdAt,...(row.kind==='record'?[row.value.updatedAt,row.value.progress?.lastActivityAt]:[]),
        ...(row.kind==='record'?row.conversations??(conversation?[conversation]:[]):[row.value]).map(session=>session.lastActivityAt)];
    const lastActivityAt=Math.max(...times.filter((at):at is number=>typeof at==='number'&&Number.isFinite(at)));
    if(row.kind==='record') {
        const progress=row.value.progress??{state:row.value.status==='confirmed'?'waiting':row.value.status==='draft'?'needs-action':row.value.status,lastActivityAt};
        const pending=(row.conversations??(conversation?[conversation]:[])).find(session=>session.state==='blocked'||session.pendingReports?.length);
        if(pending&&(['waiting','running','draft'].includes(progress.state)||progress.reason==='confirm-decision'))return {...progress,state:'needs-action',reason:pending.code??'input-required',lastActivityAt};
        return {...progress,lastActivityAt};
    }
    const state=conversation!.state;
    if(conversation!.unavailable)return {state:'failed',reason:conversation!.unavailable.code,lastActivityAt};
    if(state==='error')return {state:'failed',reason:conversation!.code,lastActivityAt};
    if(state==='cancelled'||state==='cancelling')return {state,lastActivityAt};
    if(state==='draft')return {state:'needs-action',reason:'confirm-decision',lastActivityAt};
    if(state==='blocked')return {state:'needs-action',reason:conversation!.code??'input-required',lastActivityAt};
    if(state==='preparing')return {state:'waiting',phase:'preparing',lastActivityAt};
    return {state:'draft',lastActivityAt};
}
export function decisionRowPriority(row:DecisionTableRow):number {
    if(row.kind==='conversation'&&row.value.attentionDismissal?.fingerprint===conversationAttentionFingerprint(row.value))return 1;
    if(row.kind==='record'&&row.value.archivedAt!==undefined)return 2;
    if(row.kind==='record'&&row.value.attentionDismissal&&row.value.attentionDismissal.fingerprint===recordAttentionFingerprint(row.value,row.conversations??(row.conversation?[row.conversation]:[])))return 1;
    return ['needs-action','failed','checking'].includes(decisionRowState(row).state)?0:1;
}
