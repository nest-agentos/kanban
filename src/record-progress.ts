import type {KanbanItemSummary,KanbanRecordSummary,KanbanRecordProgress,KanbanTaskProjection} from './contracts';
import {recordTaskProgress} from './record-task-progress';

type Fact={item:KanbanItemSummary;task:KanbanTaskProjection};
const priorities=['unknown','error','waiting-input','review','cancelling','pausing','paused','resuming','analyzing','running','preparing','queued','waiting-dependency','waiting-start','cancelled','completed'];
/** Business progress derives from task settlement; archive and Session liveness are independent. */
export function recordProgress(record:KanbanRecordSummary,facts:Fact[]):KanbanRecordProgress {
    const latest=Math.max(record.updatedAt??record.createdAt,...facts.map(({item})=>item.updatedAt));
    let base:Pick<KanbanRecordProgress,'lastActivityAt'|'tasks'|'stage'>={lastActivityAt:latest};
    if(record.status!=='confirmed')return {...base,state:record.status==='draft'?'needs-action':record.status,reason:record.status==='draft'?'confirm-decision':undefined};
    if(!record.itemIds.length)return {...base,state:'waiting',reason:'awaiting-execution'};
    const roots=facts.filter(({item})=>record.itemIds.includes(item.id)),groupIds=roots.map(({item})=>item.id);
    if(roots.length!==record.itemIds.length)return {...base,groupIds:record.itemIds,state:'checking',reason:'TASK_GROUP_UNAVAILABLE'};
    const scope=activeFacts(facts,new Set(groupIds),new Set(groupIds)),tasks=recordTaskProgress(scope,roots);
    base={...base,tasks,stage:tasks.execution.total?'execution':'management'};
    if(roots.every(({task})=>task.phase==='completed'))return {...base,groupIds,state:'completed',itemId:groupIds[0],completion:groupCompletion(facts)};
    const active=new Set(roots.filter(({task})=>task.phase!=='completed').map(({item})=>item.id));
    const fact=activeFacts(facts,active,new Set(groupIds)).sort((a,b)=>priorities.indexOf(a.task.phase)-priorities.indexOf(b.task.phase)||Number(a.item.planning.execution==='children')-Number(b.item.planning.execution==='children'))[0];
    const {item,task}=fact;
    const state=phaseState(task.phase);
    const reason=task.phase==='review'?'acceptance-required':task.phase==='waiting-input'?'input-required':task.reason;
    return {...base,groupIds,state,phase:task.phase,itemId:item.id,...(task.sessionId?{sessionId:task.sessionId}:{}),
        ...(reason&&/^[A-Za-z0-9_:-]{1,160}$/.test(reason)?{reason}:{})};
}
function phaseState(phase:KanbanTaskProjection['phase']):KanbanRecordProgress['state'] {
    if(phase==='unknown')return 'checking';
    if(phase==='error'||phase==='cancelled')return 'failed';
    if(phase==='waiting-input'||phase==='review')return 'needs-action';
    if(phase==='cancelling')return 'cancelling';
    if(['analyzing','running','preparing','resuming','pausing'].includes(phase))return 'running';
    return 'waiting';
}

function activeFacts(facts:Fact[],active:Set<string>,roots:Set<string>):Fact[] {
    const byId=new Map(facts.map(fact=>[fact.item.id,fact.item]));
    return facts.filter(({item})=>{
        let id:string|undefined=item.id;const seen=new Set<string>();
        while(id&&!seen.has(id)){if(roots.has(id))return active.has(id);seen.add(id);id=byId.get(id)?.planning.parentId;}
        return false;
    });
}
function groupCompletion(facts:Fact[]):KanbanRecordProgress['completion'] {
    const outcomes=facts.map(({task,item})=>item.acceptanceResult?.outcome==='waived'?'waived':task.completion);
    if(outcomes.some(outcome=>outcome==='mixed'))return 'mixed';
    if(outcomes.some(outcome=>outcome==='waived'))return 'waived';
    return 'children';
}

/** Task settlement remains intact while outstanding finalization controls decision completion. */
export function recordFinalization(progress:KanbanRecordProgress,followUps:NonNullable<KanbanRecordProgress['followUps']>):KanbanRecordProgress {
    if(progress.state!=='completed'||!followUps.length)return {...progress,followUps};
    const pending=followUps.find(row=>row.state==='unknown')??followUps.find(row=>row.state==='blocked')??followUps.find(row=>row.requiresConfirmation)??followUps[0];
    return {...progress,followUps,stage:'finalization',state:pending.state==='unknown'?'checking':pending.state==='blocked'||pending.requiresConfirmation?'needs-action':'running',
        boardId:pending.boardId,itemId:pending.itemId,reason:pending.code??(pending.requiresConfirmation?'confirmation-required':'finalization-pending')};
}
