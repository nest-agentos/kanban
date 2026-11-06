import type {KanbanActor} from './contracts';
import type {KanbanRecordRevisionCommand} from './contracts/record-revision';
import type {KanbanState} from './ports';
import {identity,requireValue,text} from './rules';
import {requireReviewer} from './amendments';
import {applyTaskCommand} from './task-commands';

/** Hold and revise related tasks in the same transaction as the decision revision. */
export function applyRecordRevision(state:KanbanState,command:KanbanRecordRevisionCommand,actor:KanbanActor,now:number):void {
    requireReviewer(state.board,actor);requireValue(actor.kind==='human','FORBIDDEN');identity(command.editId);
    const record=state.records?.find(row=>row.id===command.recordId);
    requireValue(record?.kind==='decision'&&record.deletedAt===undefined&&record.archivedAt===undefined&&!['cancelled','cancelling'].includes(record.status),'DECISION_NOT_EDITABLE');
    requireValue(Array.isArray(command.items)&&command.items.length>0&&command.items.length<=50,'INVALID_EDIT_ITEMS');
    const ids=command.items.map(row=>typeof row==='string'?row:row.id);
    requireValue(new Set(ids).size===ids.length,'INVALID_EDIT_ITEMS');
    for(const id of ids)requireValue(related(state,record.itemIds,id),'ITEM_NOT_IN_DECISION');
    if(command.type==='end-record-edit') {
        for(const itemId of ids)applyTaskCommand(state,{type:'end-edit',itemId,editId:command.editId},actor,now);
        return;
    }
    requireValue(record.revision===command.recordRevision,'RECORD_REVISION_CONFLICT');
    for(const row of command.items) {
        const item=state.board.items.find(item=>item.id===row.id);requireValue(item&&item.revision===row.revision,'ITEM_REVISION_CONFLICT');
        if(command.type==='begin-record-edit') {
            applyTaskCommand(state,{type:'begin-edit',itemId:item.id,editId:command.editId,leaseMs:300000},actor,now);
            item.launch!.editing!.persistent=true;
        }else {const updated=command.items.find(entry=>entry.id===item.id)!;applyTaskCommand(state,{type:'save-edit',itemId:item.id,editId:command.editId,title:updated.title,responsibility:updated.responsibility,acceptance:updated.acceptance,planning:item.planning!},actor,now);}
    }
    if(command.type==='save-record-edit') {
        text(command.title);text(command.content);text(command.rationale);
        Object.assign(record,{title:command.title,content:command.content,rationale:command.rationale,revision:record.revision+1,updatedAt:now});
    }
}
function related(state:KanbanState,roots:string[],id:string):boolean {
    const seen=new Set<string>();
    while(!seen.has(id)) {if(roots.includes(id))return true;seen.add(id);const parent=state.board.items.find(row=>row.id===id)?.planning?.parentId;if(!parent)return false;id=parent;}
    return false;
}
