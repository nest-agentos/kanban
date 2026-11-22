import {currentAnalysis} from './analysis-history';
import {kanbanReference} from '../contracts/references';
import {defaultReferences,type KanbanReferencePolicy} from './ports';
import type {KanbanBoard,KanbanItem} from '../contracts';
import type {KanbanAutomationJournal} from './automation-journal';

export interface DecisionContext {sourceBoardId:string;recordId:string;recordRevision:number;runId:string;previousRunId?:string}
/** The host resolves business identity; execution transports receive opaque structured context. */
export async function workContext(journal:KanbanAutomationJournal,board:KanbanBoard,item:KanbanItem,references:KanbanReferencePolicy=defaultReferences) {
    const runId=item.externalRefs?.find(ref=>ref.system===references.decision)?.id;
    let decision=runId?await journal.get<DecisionContext>('record-context:'+runId):undefined;
    if(runId&&!decision) {
        const run=await journal.run<{id:string;sourceBoardId:string;recordId:string;recordRevision:number}>(board.id,runId);
        if(run)decision={sourceBoardId:run.sourceBoardId,recordId:run.recordId,recordRevision:run.recordRevision,runId};
    }
    const snapshot = decision ? (await journal.run<{record:unknown}>(decision.sourceBoardId,decision.runId))?.record : undefined;
    if(decision){const {previousRunId:_previous,...current}=decision;decision=current;}
    const own=await currentAnalysis(journal,board.id,item.id);
    const approved=own?.status.state==='ready'?own:item.planning?.parentId?await currentAnalysis(journal,board.id,item.planning.parentId):undefined;
    return {...(approved?.status.state==='ready'&&approved.result?{planning:{id:approved.id,result:approved.result}}:{}),board:{id:board.id,title:board.title,revision:board.revision,reference:kanbanReference(board)},decision:decision ? {...decision,...(snapshot ? {snapshot} : {})} : null,
        task:{id:item.id,revision:item.revision,reference:kanbanReference(board,item),parentId:item.planning?.parentId??null,title:item.title,responsibility:item.responsibility,acceptance:item.acceptance,
            dependencies:item.planning?.dependencies??[]},
        resources:item.externalRefs?.filter(ref=>ref.system===references.resource)??[]};
}
