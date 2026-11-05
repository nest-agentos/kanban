import {sha256HexSync} from '../utils';
import {DEFAULT_KANBAN_WORK_TYPES, type KanbanBoard, type KanbanItem, type KanbanService, type KanbanWorkDefinition, type KanbanEstimate} from '../contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import {requireValue} from '../rules';

export interface AnalysisSubtask {key:string;title:string;responsibility:string;acceptance:string;dependsOn:string[];estimate?:KanbanEstimate}
interface Input {id:string;reason:string;dependencies:string[];subtasks:AnalysisSubtask[]}
export function validateSubtasks(value:unknown):AnalysisSubtask[]|undefined {
    if(value===undefined)return;
    requireValue(Array.isArray(value)&&value.length>=2&&value.length<=16,'AUTOMATION_SUBTASKS_INVALID');
    const tasks=value as AnalysisSubtask[],keys=new Set(tasks.map(task=>task?.key));
    requireValue(keys.size===tasks.length,'AUTOMATION_SUBTASKS_INVALID');
    for(const task of tasks) {
        requireValue(task&&typeof task.key==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(task.key)&&[task.title,task.responsibility,task.acceptance].every(text=>typeof text==='string'&&text.trim().length>0&&text.length<=8000),'AUTOMATION_SUBTASKS_INVALID');
        requireValue(Array.isArray(task.dependsOn)&&task.dependsOn.length<=16&&new Set(task.dependsOn).size===task.dependsOn.length
            &&task.dependsOn.every(key=>keys.has(key)&&key!==task.key),'AUTOMATION_SUBTASK_DEPENDENCY_INVALID');
        if(task.estimate)requireValue(['low','medium','high'].includes(task.estimate.confidence)&&[task.estimate.complexity,task.estimate.workUnits,task.estimate.durationMs].every(number=>Number.isFinite(number)&&number>0),'AUTOMATION_ESTIMATE_INVALID');
    }
    const pending=[...tasks],done=new Set<string>();
    while(pending.length) {const index=pending.findIndex(task=>task.dependsOn.every(key=>done.has(key)));requireValue(index>=0,'DEPENDENCY_CYCLE');done.add(pending.splice(index,1)[0].key);}
    return tasks;
}
/** The model supplies local keys; the host owns stable identities, resource inheritance and publication. */
export async function adoptDecomposition(journal:KanbanAutomationJournal, board:KanbanBoard, parent:KanbanItem, input:Input, service:KanbanService, inherited: import('../contracts').KanbanExternalReference[] = []):Promise<void> {
    const types=board.workTypes??DEFAULT_KANBAN_WORK_TYPES,parentRank=types.find(type=>type.id===(parent.planning?.kind??board.defaultWorkType??'task'))?.rank;
    const type=types.filter(type=>type.executable&&parentRank!==undefined&&type.rank>parentRank).sort((a,b)=>a.rank-b.rank)[0];
    requireValue(type,'AUTOMATION_SUBTASK_TYPE_UNAVAILABLE');
    const ids=new Map(input.subtasks.map(task=>[task.key,'sub-'+sha256HexSync(JSON.stringify([input.id,task.key])).slice(0,40)]));
    const definitions:KanbanWorkDefinition[]=input.subtasks.map(task=>({id:ids.get(task.key)!,workType:type.id,title:task.title,responsibility:task.responsibility,acceptance:task.acceptance,
        assignee:board.automation!.worker,externalRefs:inherited,
        dependsOn:[...new Set([...input.dependencies,...task.dependsOn.map(key=>ids.get(key)! )])],outputs:['result']}));
    for(const [index,definition] of definitions.entries()) {
        const estimate=input.subtasks[index].estimate;
        requireValue(board.policy.requireEstimate===false||estimate,'ESTIMATE_REQUIRED');
        if(estimate)await journal.update('decomposition-estimate:'+JSON.stringify([board.id,definition.id]),old=>old??estimate);
        await journal.update('decomposition-status:'+JSON.stringify([board.id,definition.id]),old=>old??{itemId:definition.id,state:'ready',reason:input.reason,dependencies:definition.dependsOn});
    }
    await service.execute(board.id,{operationId:'analysis-plan:'+input.id,expectedRevision:board.revision,command:{type:'publish-plan',plan:{
        schema:'kanban.plan/1',id:input.id,revision:1,sealed:true,rootItemId:parent.id,items:definitions}}});
}
