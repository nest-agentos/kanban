import type {KanbanExternalReference} from './configuration';
import type {KanbanRecordQuery,KanbanRecordSummary} from './context';
import type {KanbanRecordConversation} from './record-conversation';
import type {KanbanDecisionQuery,KanbanDecisionRow} from './decision-page';
import {decisionRowPriority,decisionRowState} from './decision-row-state';

function includesProject(references:KanbanExternalReference[]|undefined,projects:KanbanExternalReference[]):boolean {
    return projects.some(project=>references?.some(ref=>ref.system===project.system&&ref.id===project.id));
}

export function decisionRecordsQuery(query:KanbanDecisionQuery):KanbanRecordQuery {
    return {kind:'decision',limit:200,includeArchived:query.includeArchived??query.archived??false,
        ...(query.resource?{resource:query.resource}:{}),...(query.resources?.length?{resources:query.resources}:{})};
}

export function decisionRows(records:KanbanRecordSummary[],conversations:KanbanRecordConversation[],query:KanbanDecisionQuery):KanbanDecisionRow[] {
    const matches=(refs:KanbanExternalReference[]|undefined)=>
        (!query.resource||includesProject(refs,[query.resource]))&&(!query.resources?.length||includesProject(refs,query.resources));
    const drafts=query.archived?[]:conversations.filter(row=>(row.sessionId||row.resourceId)&&!row.recordId&&matches(row.resources));
    const rows=records.filter(row=>matches(row.externalRefs)&&(query.archived?row.archivedAt!==undefined:query.includeArchived||row.archivedAt===undefined));
    return [...rows.map(value=>{
        const sessions=conversations.filter(row=>row.recordId===value.id);
        return {kind:'record' as const,value,conversations:sessions,conversation:sessions.find(row=>row.purpose==='coordination')??sessions[0]};
    }),...drafts.map(value=>({kind:'conversation' as const,value}))];
}

function normalizedTitle(value:string):string {return value.normalize('NFKC').trim().toLowerCase();}

export function decisionPageFilter(rows:KanbanDecisionRow[],query:KanbanDecisionQuery) {
    const search=normalizedTitle(query.search??'');
    if(search)rows=rows.filter(row=>normalizedTitle(row.value.title??'').includes(search));
    const attention=new Set(rows.filter(row=>decisionRowPriority(row)===0));
    const states=new Set(query.states);
    const byState=states.size?rows.filter(row=>states.has(decisionRowState(row).state)||(states.has('attention')&&attention.has(row))):rows;
    const needsAttention=byState.filter(row=>attention.has(row));
    return {attentionTotal:needsAttention.length,visible:query.attentionOnly?needsAttention:byState};
}
