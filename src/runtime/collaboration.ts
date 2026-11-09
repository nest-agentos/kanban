import {commitCollaboration} from './collaboration-commit';
import type {KanbanClient,KanbanBoard,KanbanItem,KanbanDispatch,KanbanProjectRecord} from '../contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import type {SavedFix,Snapshot} from './task-fix-ports';
import type {KanbanCommand} from '../contracts';
import {analysisHistory,type AnalysisJournalEntry} from './analysis-history';
import {randomUUID,sha256HexSync} from '../utils';
import {requireValue} from '../rules';
export interface KanbanFixPreparation {resourceId:string;context:unknown;origin?:{id:string;input:unknown}}
export class KanbanCollaboration {
    constructor(private readonly service:KanbanClient,private readonly journal:KanbanAutomationJournal) {}
    async prepareFix(boardId:string,request:{itemId:string;operationId:string},prepare:(input:{id:string;board:KanbanBoard;item:KanbanItem})=>Promise<KanbanFixPreparation>):Promise<SavedFix> {
        requireValue(/^[\w-]{1,128}$/.test(request.operationId),'INVALID_OPERATION_ID');
        const board=await this.service.read(boardId),item=(await this.service.item(boardId,request.itemId)).item;
        requireValue(!board.lifecycle,'BOARD_STOPPING');requireValue(item.deletedAt===undefined,'ITEM_DELETED');
        requireValue(item.planning?.execution==='children'||item.launch?.admittedAt!==undefined||['claimed','review','completed'].includes(item.status),'FIX_REQUIRES_STARTED_TASK');
        const active=(await this.journal.findForBoard<SavedFix>('fix:',boardId,fix=>fix.itemId===item.id&&!fix.accepted&&fix.state!=='cancelled'))[0]?.value;
        const id=await this.journal.update<string>('fix-operation:'+boardId+':'+request.operationId,old=>old??active?.id??randomUUID());
        let fix=await this.journal.get<SavedFix>('fix:'+id);
        requireValue(!fix||fix.boardId===boardId&&fix.itemId===item.id,'IDEMPOTENCY_CONFLICT');
        if(!fix) {
            requireValue(board.automation,'FIX_PREPARATION_UNAVAILABLE');
            const prepared=await prepare({id,board,item});
            const dispatch:KanbanDispatch={id,itemId:item.id,itemRevision:item.revision,planId:id,planRevision:1,principal:board.automation.worker,
                definitionDigest:sha256HexSync(JSON.stringify(prepared.context)),attempt:1,fence:id,preparedAt:Date.now(),outcome:'prepared',inputs:{}};
            fix=await this.journal.update<SavedFix>('fix:'+id,old=>old??{id,boardId,itemId:item.id,sessionId:id,state:'clarifying',phase:'prepared',dispatch,item:structuredClone(item),
                resourceId:prepared.resourceId,context:prepared.context,origin:prepared.origin,request:null});
        }
        await this.journal.update<string[]>('fix-index',old=>old?.includes(id)?old:[...old??[],id]);return fix;
    }
    async fix(id:string):Promise<SavedFix> {
        const fix=await this.journal.get<SavedFix>('fix:'+id);requireValue(fix,'FIX_NOT_FOUND');
        await this.service.item(fix.boardId,fix.itemId);return fix;
    }
    async confirmFix(id:string,snapshot:Snapshot):Promise<SavedFix> {
        const fix=await this.fix(id);requireValue(!['cancelling','cancelled'].includes(fix.state),'FIX_INPUT_CLOSED');
        return this.journal.update<SavedFix>('fix:'+id,old=>{
            requireValue(old&&!['cancelling','cancelled'].includes(old.state),'FIX_INPUT_CLOSED');
            requireValue(!old.snapshot||old.snapshot.messageId===snapshot.messageId&&old.snapshot.digest===snapshot.digest,'FIX_INPUT_CLOSED');
            return old.snapshot?old:{...old,snapshot:structuredClone(snapshot),state:'frozen'};
        });
    }
    async acceptFix(id:string,policy:{kind:string;inheritSystems:string[]},deliver:(fix:SavedFix)=>Promise<void>):Promise<void> {
        const fix=await this.fix(id),snapshot=fix.snapshot;requireValue(snapshot,'FIX_PROPOSAL_REQUIRED');
        if(fix.accepted)return;
        requireValue(!['cancelling','cancelled'].includes(fix.state),'FIX_INPUT_CLOSED');
        const board=await this.service.read(fix.boardId);
        requireValue(!!snapshot.definition.children||!board.workTypes?.length||board.workTypes.some(type=>type.id===policy.kind&&type.executable),'FIX_WORK_TYPE_REQUIRED');
        await this.publishFix(fix);
        const command=fixCommand(fix,policy);
        await commitCollaboration(this.service,this.journal,{id:fix.id,boardId:fix.boardId,itemId:fix.itemId,commandKey:'fix-create:'+fix.id,command,children:snapshot.definition.children,repairItemId:snapshot.definition.repair?.itemId},()=>deliver(fix));
        await this.journal.update<SavedFix>('fix:'+id,old=>({...old!,accepted:true,state:'accepted',createdItemId:snapshot.definition.children?fix.itemId:snapshot.operationId}));
    }
    private async publishFix(fix:SavedFix):Promise<void> {
        const snapshot=fix.snapshot!,envelope={schema:'kanban.fix/1',version:1,operationId:snapshot.operationId,sourceSessionId:fix.sessionId,
            confirmation:{messageId:snapshot.messageId,content:snapshot.content,digest:snapshot.digest},board:{id:fix.boardId},resource:{id:fix.resourceId},...snapshot.definition};
        await this.journal.update('fix-definition:'+fix.id,old=>{requireValue(!old||JSON.stringify(old)===JSON.stringify(envelope),'FIX_DEFINITION_CHANGED');return old??envelope;});
    }
    async decisionSnapshot(identity:{sourceBoardId:string;recordId:string;recordRevision:number;runId:string}):Promise<KanbanProjectRecord> {
        await this.service.read(identity.sourceBoardId);
        const runs=await this.journal.get<Array<{id:string;record:KanbanProjectRecord}>>('record-runs:'+identity.sourceBoardId);
        const record=runs?.find(run=>run.id===identity.runId)?.record??await this.service.record(identity.sourceBoardId,identity.recordId);
        requireValue(record.id===identity.recordId&&record.revision===identity.recordRevision,'FIX_DECISION_REVISION_UNAVAILABLE');return record;
    }

}
/** Adapter requests remain opaque; relation projection does not expose journal layouts. */
export async function collaborationRelations<Input=unknown>(journal:KanbanAutomationJournal,boardId:string,itemId:string) {
    const analyses=await analysisHistory<AnalysisJournalEntry & {input:Input}>(journal,boardId,itemId);
    const replies=await journal.findForBoard<{sessionId:string;phase?:string;request:{itemId:string;operationId:string}}>('task-reply:',boardId,row=>row.request.itemId===itemId&&row.phase!=='cancelled');
    const activeReplies:Array<{operationId:string;executionId:string}>=[];
    for(const {value} of replies)if(!await journal.get('task-reply-cancelled:'+value.request.operationId))activeReplies.push({operationId:value.request.operationId,executionId:value.sessionId});
    return {planning:analyses.map(job=>({id:job.id,request:job.input})),replies:activeReplies};
}

function fixCommand(fix:SavedFix,policy:{kind:string;inheritSystems:string[]}):KanbanCommand{
    const snapshot=fix.snapshot!,definition=snapshot.definition;
    const plan={schema:'kanban.plan/1' as const,id:snapshot.operationId,revision:1,sealed:true,mode:'append' as const,rootItemId:fix.itemId,items:definition.children!};
    if(definition.repair)return {type:'insert-repair-dependency',itemId:definition.repair.itemId,expectedItemRevision:definition.repair.revision,plan};
    if(definition.children)return {type:'publish-plan',plan};
    return {type:'create-item',item:{id:snapshot.operationId,title:definition.title,responsibility:definition.responsibility,acceptance:definition.acceptance,externalRefs:fix.item.externalRefs?.filter(ref=>policy.inheritSystems.includes(ref.system))},planning:{kind:policy.kind,priority:fix.item.planning?.priority??2,dependencies:definition.dependencies,references:[]}};
}
