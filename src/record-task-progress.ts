import type {KanbanItemSummary,KanbanTaskProjection,KanbanRecordProgress} from './contracts';
import {kanbanTaskType} from './contracts/task-type';
import {taskProgress,mergeTaskProgress} from './task-progress';
type Fact={item:KanbanItemSummary;task:KanbanTaskProjection};

/** Complete descendants or a bounded root summary count each execution once. */
export function recordTaskProgress(facts:Fact[],roots:Fact[]):NonNullable<KanbanRecordProgress['tasks']> {
    const managers=roots.filter(({item})=>kanbanTaskType(item)==='coordination');
    const executions=facts.filter(({item})=>kanbanTaskType(item)==='execution');
    const byId=new Map(facts.map(({item})=>[item.id,item]));
    const summarized=managers.filter(root=>root.item.progress&&executions.filter(({item})=>within(item,root.item.id,byId)).length<root.item.progress.total);
    const concrete=executions.filter(({item})=>!summarized.some(root=>within(item,root.item.id,byId)));
    const execution=taskProgress(concrete.map(({task})=>task.phase));
    for(const root of summarized)mergeTaskProgress(execution,root.item.progress!);
    return {management:taskProgress(managers.map(({task})=>task.phase)),execution};
}
function within(item:KanbanItemSummary,root:string,byId:Map<string,KanbanItemSummary>):boolean {
    const seen=new Set<string>();let id:string|undefined=item.id;
    while(id&&!seen.has(id)){if(id===root)return true;seen.add(id);id=byId.get(id)?.planning.parentId;}
    return false;
}
