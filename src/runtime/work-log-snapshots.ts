import type {KanbanService, KanbanItemSummary, KanbanProjectRecord} from '../contracts';
import type {createWorkLogProjection} from './work-log-events';

/** Reconcile legacy projections using persisted facts without executing coordination commands. */
export async function workLogSnapshots(boardId:string, source:KanbanService, items:KanbanItemSummary[], seen:Set<string>, projection: ReturnType<typeof createWorkLogProjection>):Promise<KanbanProjectRecord[]> {
    const {activityRecord, ancestorIds, lifecycleReferences} = projection;
    const workflow=await source.workflow(boardId), records=bindingSnapshots(boardId,items,seen,projection);
    for(const dispatch of Object.values(workflow.dispatches)) {
        const item=items.find(item=>item.id===dispatch.itemId);
        if(dispatch.outcome!=='accepted'||item?.status!=='completed')continue;
        records.push(activityRecord({id:boardId},item,`${dispatch.id}:task.completed:`,item.closedAt??Date.now(),
            {stage:'task.completed',result:'success',dispatchId:dispatch.id,fields:{evidence:'accepted-dispatch'}},
            lifecycleReferences(item.externalRefs),undefined,ancestorIds(item,items)));
    }
    return records;
}
function bindingSnapshots(board:string, items:KanbanItemSummary[], seen:Set<string>, projection: ReturnType<typeof createWorkLogProjection>):KanbanProjectRecord[] {
    const {activityRecord, ancestorIds, lifecycleReferences} = projection;
    const at=Date.now();
    return items.flatMap(item=>{
        const refs=lifecycleReferences(item.externalRefs).filter(ref=>!seen.has(JSON.stringify([item.id,ref.system,ref.id])));
        if(!refs.length)return [];
        return [activityRecord({id:board},item,'snapshot:'+item.id,at,
            {stage:'association.observed',result:'success',fields:{evidence:'existing-reference'}},refs,undefined,ancestorIds(item,items))];
    });
}
