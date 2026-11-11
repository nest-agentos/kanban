import {DEFAULT_KANBAN_WORK_TYPES,type KanbanBoard,type KanbanItem,type KanbanEstimate,type KanbanExternalReference} from '../contracts';
import type {Definition} from './task-fix-ports';
import {requireValue,identity} from '../rules';
export interface CoordinationResult {schema:'kanban.coordination/1';summary:string;suggestions:Array<{itemId:string;action:string;reason:string}>}
export function validateCoordinationResult(output:unknown,children:readonly {id:string}[],allowedActions:readonly string[]):asserts output is CoordinationResult{
    const result=output as CoordinationResult;
    requireValue(result?.schema==='kanban.coordination/1'&&typeof result.summary==='string'&&result.summary.length<=8000&&Array.isArray(result.suggestions)&&result.suggestions.length<=16,'COORDINATION_RESULT_INVALID');
    const ids=new Set(children.map(child=>child.id)),actions=new Set(allowedActions);
    requireValue(result.suggestions.every(s=>s&&typeof s.itemId==='string'&&ids.has(s.itemId)&&typeof s.action==='string'&&actions.has(s.action)&&typeof s.reason==='string'&&s.reason.length<=2000),'COORDINATION_RESULT_INVALID');
}
export interface CoordinationTask {key:string;title:string;responsibility:string;acceptance:string;dependsOn:string[];estimate?:KanbanEstimate}
interface Proposal {schema:string;type:string;repairItemId?:string;tasks:CoordinationTask[]}
export interface CoordinationProposalPolicy {idForKey(key:string):string;inheritReferences(refs:KanbanExternalReference[]):KanbanExternalReference[]}
/** Parse domain proposals without knowing a host's identity scheme or resource systems. */
export function compileCoordinationProposal(input:unknown,parent:KanbanItem,board:KanbanBoard,policy:CoordinationProposalPolicy):Definition{
    const value=input as Proposal;
    requireValue(value?.schema==='kanban.coordination-proposal/1'&&['append','repair'].includes(value.type)&&Array.isArray(value.tasks)&&value.tasks.length>0&&value.tasks.length<=16,'COORDINATION_PROPOSAL_INVALID');
    for(const task of value.tasks)validateTask(task,board.policy.requireEstimate!==false);
    const keys=new Map(value.tasks.map(task=>[task.key,policy.idForKey(task.key)]));
    requireValue(keys.size===value.tasks.length&&new Set(keys.values()).size===keys.size,'COORDINATION_PROPOSAL_INVALID');
    for(const id of keys.values())identity(id);
    const existing=new Set(board.items.filter(item=>item.planning?.parentId===parent.id&&!item.deletedAt).map(item=>item.id));
    const types=board.workTypes??DEFAULT_KANBAN_WORK_TYPES,rank=types.find(type=>type.id===parent.planning?.kind)?.rank;
    const childType=types.filter(type=>type.executable&&rank!==undefined&&type.rank>rank).sort((a,b)=>a.rank-b.rank)[0];
    requireValue(childType&&board.automation,'AUTOMATION_SUBTASK_TYPE_UNAVAILABLE');
    const children=value.tasks.map(task=>{
        requireValue(task.dependsOn.every(key=>(keys.has(key)||existing.has(key))&&key!==task.key),'AUTOMATION_SUBTASK_DEPENDENCY_INVALID');
        return {id:keys.get(task.key)!,workType:childType.id,title:task.title,responsibility:task.responsibility,acceptance:task.acceptance,assignee:board.automation!.worker,dependsOn:task.dependsOn.map(key=>keys.get(key)??key),outputs:['result'],estimate:task.estimate,externalRefs:policy.inheritReferences(parent.externalRefs??[])};
    });
    validateAcyclic(children,existing);
    const target=value.type==='repair'?board.items.find(item=>item.id===value.repairItemId&&item.planning?.parentId===parent.id&&!item.deletedAt):undefined;
    requireValue(value.type!=='repair'||target&&children.length===1&&!children[0].dependsOn.includes(target.id),'REPAIR_TARGET_INVALID');
    return {...(target?{repair:{itemId:target.id,revision:target.revision}}:{}),title:parent.title,responsibility:parent.responsibility,acceptance:parent.acceptance,type:'append',dependencies:[],children};
}
function validateTask(task:CoordinationTask,estimate:boolean):void{
    requireValue(task&&typeof task.key==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(task.key)&&[task.title,task.responsibility,task.acceptance].every(text=>typeof text==='string'&&text.trim().length>0&&text.length<=8000),'COORDINATION_PROPOSAL_INVALID');
    requireValue(Array.isArray(task.dependsOn)&&task.dependsOn.length<=100&&task.dependsOn.every(key=>typeof key==='string')&&new Set(task.dependsOn).size===task.dependsOn.length,'AUTOMATION_SUBTASK_DEPENDENCY_INVALID');
    requireValue(!estimate||task.estimate,'ESTIMATE_REQUIRED');
    if(task.estimate)requireValue(['low','medium','high'].includes(task.estimate.confidence)&&[task.estimate.complexity,task.estimate.workUnits,task.estimate.durationMs].every(value=>Number.isFinite(value)&&value>0),'AUTOMATION_ESTIMATE_INVALID');
}
function validateAcyclic(children:Array<{id:string;dependsOn:string[]}>,existing:Set<string>):void{
    const pending=[...children],done=new Set(existing);
    while(pending.length){const index=pending.findIndex(task=>task.dependsOn.every(key=>done.has(key)));requireValue(index>=0,'DEPENDENCY_CYCLE');done.add(pending.splice(index,1)[0].id);}
}
/** Include roots and descendants with bounded traversal even for corrupt cyclic ancestry. */
export function itemWithinRoots(items:readonly {id:string;planning?:{parentId?:string}}[],id:string,roots:readonly string[]):boolean{
    return within(new Map(items.map(item=>[item.id,item])),id,new Set(roots));
}
function within(byId:Map<string,{planning?:{parentId?:string}}>,id:string,roots:Set<string>):boolean{
    const seen=new Set<string>();
    for(let next:string|undefined=id;next&&!seen.has(next);next=byId.get(next)?.planning?.parentId){if(roots.has(next))return true;seen.add(next);}
    return false;
}
export function itemsWithinRoots(items:readonly KanbanItem[],roots:readonly string[],options:{includeDeleted?:boolean}={}):KanbanItem[]{
    const byId=new Map(items.map(item=>[item.id,item])),scope=new Set(roots);
    return items.filter(item=>(options.includeDeleted||item.deletedAt===undefined)&&within(byId,item.id,scope));
}

/** Canonical parent links establish ownership; titles and conversation state never infer it. */
export function managementTaskOwner(board:KanbanBoard,item:KanbanItem):KanbanItem|undefined {
    let current=item,owner=item.planning?.execution==='children'?item:undefined;
    const byId=new Map(board.items.map(row=>[row.id,row]));
    const visited=new Set([item.id]);
    while(current.planning?.parentId){
        const parent=byId.get(current.planning.parentId);
        requireValue(parent&&!visited.has(parent.id),'OPERATION_OWNER_INVALID');
        visited.add(parent.id);current=parent;
        if(parent.planning?.execution==='children')owner=parent;
    }
    return owner;
}
