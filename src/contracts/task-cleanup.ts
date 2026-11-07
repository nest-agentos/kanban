import type {KanbanItem,KanbanItemSummary,KanbanWorkflowState} from './index';
type Item=Pick<KanbanItem,'id'|'status'>&Partial<Pick<KanbanItem,'restartPending'|'repairPending'|'deletedAt'|'analysis'|'control'|'launch'|'planning'>>;
/** Only durable terminal evidence permits cleanup; idle or missing sessions are insufficient. */
export function taskCleanupAllowed(item:Item,workflow?:KanbanWorkflowState,related:(Pick<KanbanItemSummary,'id'|'status'>&Partial<KanbanItemSummary>)[]=[],seen=new Set<string>()):boolean {
    if(seen.has(item.id))return false;seen=new Set(seen).add(item.id);
    if(item.deletedAt!==undefined||item.restartPending||item.repairPending)return false;
    if(['completed','cancelled'].includes(item.status))return true;
    if(item.control&&!(item.control.action==='cancel'&&item.control.state==='cancelled'))return false;
    if(item.analysis&&['analyzing','unknown'].includes(item.analysis.state))return false;
    const children=related.filter(row=>row.planning?.parentId===item.id&&!row.deletedAt);
    if(children.some(child=>!taskCleanupAllowed(child,workflow,related,seen)))return false;
    const dispatches=Object.values(workflow?.dispatches??{}).filter(row=>row.itemId===item.id);
    if(dispatches.some(row=>['prepared','running','unknown','succeeded'].includes(row.outcome)))return false;
    if(item.planning?.execution==='children')return true;
    if(['claimed','review'].includes(item.status)||item.launch?.admittedAt!==undefined)
        return dispatches.length>0&&dispatches.every(row=>['failed','cancelled','rejected','accepted'].includes(row.outcome));
    return true;
}
