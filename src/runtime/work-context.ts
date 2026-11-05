import {kanbanReference} from '../contracts/references';
import {defaultReferences,type KanbanReferencePolicy} from './ports';
import type {KanbanBoard,KanbanItem} from '../contracts';
import type {KanbanAutomationJournal} from './automation-journal';

export interface DecisionContext {sourceBoardId:string;recordId:string;recordRevision:number;runId:string}
/** The host resolves business identity; execution transports receive opaque structured context. */
export async function workContext(journal:KanbanAutomationJournal,board:KanbanBoard,item:KanbanItem,references:KanbanReferencePolicy=defaultReferences) {
    const runId=item.externalRefs?.find(ref=>ref.system===references.decision)?.id;
    let decision=runId?await journal.get<DecisionContext>('record-context:'+runId):undefined;
    if(runId&&!decision) {
        const runs=await journal.get<Array<{id:string;sourceBoardId:string;recordId:string;recordRevision:number}>>('record-runs:'+board.id);
        const run=runs?.find(run=>run.id===runId);
        if(run)decision={sourceBoardId:run.sourceBoardId,recordId:run.recordId,recordRevision:run.recordRevision,runId};
    }
    const snapshot = decision ? (await journal.get<Array<{id:string;record:unknown}>>('record-runs:'+decision.sourceBoardId))?.find(run=>run.id===decision.runId)?.record : undefined;
    return {board:{id:board.id,title:board.title,revision:board.revision,reference:kanbanReference(board)},decision:decision ? {...decision,...(snapshot ? {snapshot} : {})} : null,
        task:{id:item.id,revision:item.revision,reference:kanbanReference(board,item),parentId:item.planning?.parentId??null,title:item.title,responsibility:item.responsibility,acceptance:item.acceptance,
            dependencies:item.planning?.dependencies??[]},
        resources:item.externalRefs?.filter(ref=>ref.system===references.resource)??[]};
}
