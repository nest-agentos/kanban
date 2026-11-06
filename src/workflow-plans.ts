import type {KanbanActor, KanbanCommand, KanbanWorkDefinition, KanbanWorkPlan, KanbanPublishedPlan} from './contracts';
import type {KanbanState} from './ports';
import {sha256HexSync} from './utils';
import {identity, requireValue} from './rules';
import {principal, principalKey, validateCandidates} from './identity';
import {plan as planning} from './planning';
export type ApplyWorkCommand = (command: KanbanCommand, actor?: KanbanActor) => void;

export function requireCoordinator(state: KanbanState, actor: KanbanActor): void {
    requireValue(state.board.members?.some(member => principalKey(member) === principalKey(principal(actor)) && member.roles?.includes('coordinator')), 'COORDINATOR_REQUIRED');
}
export function publishPlan(state: KanbanState, plan: KanbanWorkPlan, actor: KanbanActor, apply: ApplyWorkCommand): void {
    requireCoordinator(state, actor); requireValue(plan && typeof plan === 'object', 'INVALID_WORK_PLAN'); identity(plan.id);
    requireValue(plan.schema === 'kanban.plan/1' && typeof plan.sealed === 'boolean' && Array.isArray(plan.items) && plan.items.length > 0 && plan.items.length <= 100, 'INVALID_WORK_PLAN');
    const workflow = state.workflow!, previous = workflow.plans[plan.id];
    requireValue(Number.isSafeInteger(plan.revision) && plan.revision === (previous?.revision ?? 0) + 1, 'PLAN_REVISION_CONFLICT');
    requireValue(!Object.values(workflow.dispatches).some(dispatch => dispatch.planId === plan.id && ['prepared','running','unknown','succeeded'].includes(dispatch.outcome)), 'PLAN_EXECUTION_UNSETTLED');
    if (plan.decisionId) {
        const decision=state.records?.find(record => record.id === plan.decisionId && record.kind === 'decision' && record.status === 'confirmed');
        requireValue(decision, 'DECISION_NOT_CONFIRMED');
        if(decision.coordination) requireValue(principalKey(decision.coordination.manager)===principalKey(principal(actor)), 'DECISION_MANAGER_REQUIRED');
    }
    requireValue(plan.mode===undefined||plan.mode==='append'&&!!plan.rootItemId,'INVALID_WORK_PLAN');
    requireValue(plan.coordination===undefined||typeof plan.coordination==='boolean','INVALID_WORK_PLAN');
    if(plan.rootItemId) {
        const root=state.board.items.find(item=>item.id===plan.rootItemId);
        requireValue(root&&!root.owner&&!root.deletedAt&&root.control?.action!=='cancel','PLAN_ROOT_UNAVAILABLE');
        if(plan.mode==='append') {
            requireValue(!previous&&root.planning?.execution==='children'&&['backlog','open','completed'].includes(root.status),'PLAN_ROOT_UNAVAILABLE');
            requireValue(plan.items.every(item=>!state.board.items.some(existing=>existing.id===item.id)&&!state.archiveIndex?.some(existing=>existing.id===item.id)),'APPEND_REQUIRES_NEW_ITEMS');
            if(root.status==='completed'){root.status='backlog';delete root.closedAt;delete root.resultRef;root.revision++;}
        }else requireValue(['backlog','open'].includes(root.status),'PLAN_ROOT_UNAVAILABLE');
        delete root.purpose;
        if(plan.coordination===true)root.planning={...planning(root),coordination:true};
        if(root.planning?.execution!=='children')apply({type:'plan-item',itemId:root.id,planning:{...planning(root),execution:'children'}});
    }
    const ordered = orderWork(plan.items, state), definitions: KanbanPublishedPlan['definitions'] = {};
    for (const item of ordered) {
        const digest = sha256HexSync(JSON.stringify(item));
        requireValue(!Object.values(workflow.plans).some(other => other.id !== plan.id && other.itemIds.includes(item.id)), 'ITEM_IN_OTHER_PLAN');
        const exists=state.board.items.some(old => old.id === item.id)||state.archiveIndex?.some(old=>old.id===item.id);
        if (exists && previous?.definitions[item.id]?.digest !== digest) {
            requireValue(!previous?.definitions[item.id], 'PLAN_ITEM_CHANGED_REQUIRES_NEW_ID');
            adoptItem(state, item, apply);
        }
        if (!exists) apply({type:'create-item', item:{id:item.id,title:item.title,responsibility:item.responsibility,acceptance:item.acceptance,eligiblePrincipals:[item.assignee],externalRefs:item.externalRefs},
            planning:{kind:item.workType??state.board.defaultWorkType ?? 'task',priority:2,dependencies:item.dependsOn,references:[],...(plan.rootItemId ? {parentId:plan.rootItemId}: {})}});
        definitions[item.id] = {digest, inputs:item.inputs, outputs:item.outputs ?? []};
    }
    workflow.plans[plan.id] = {schema:plan.schema,id:plan.id,revision:plan.revision,decisionId:plan.decisionId,rootItemId:plan.rootItemId,sealed:plan.sealed,itemIds:ordered.map(item=>item.id),definitions};
}
function adoptItem(state: KanbanState, definition: KanbanWorkDefinition, apply: ApplyWorkCommand): void {
    const item = state.board.items.find(item => item.id === definition.id);
    requireValue(item && definition.expectedRevision === item.revision && ['backlog', 'open'].includes(item.status)
        && !item.owner && !item.blocked && (!item.control || item.control.action === 'resume' && item.control.state === 'resumed'), 'PLAN_ITEM_CHANGED_REQUIRES_NEW_ID');
    requireValue(!definition.workType||definition.workType===item.planning?.kind,'PLAN_ITEM_CHANGED_REQUIRES_NEW_ID');
    requireValue(!definition.externalRefs||definition.externalRefs.every(ref=>item.externalRefs?.some(existing=>JSON.stringify(existing)===JSON.stringify(ref))),'PLAN_RESOURCE_MISMATCH');
    requireValue(item.title === definition.title && item.responsibility === definition.responsibility
        && item.acceptance === definition.acceptance, 'PLAN_ITEM_CHANGED_REQUIRES_NEW_ID');
    requireValue(planning(item).dependencies.every(id => definition.dependsOn.includes(id)), 'EXISTING_DEPENDENCY_REQUIRED');
    apply({type: 'plan-item', itemId: item.id, planning: {...planning(item), dependencies: definition.dependsOn}});
    delete item.purpose;
    item.eligiblePrincipals = [definition.assignee]; delete item.eligibleAgentIds;
    validateCandidates(state.board, item, true);
}
function orderWork(items: KanbanWorkDefinition[], state: KanbanState): KanbanWorkDefinition[] {
    for (const item of items) validateDefinition(item);
    const ids = new Set(items.map(item => item.id)); requireValue(ids.size === items.length, 'DUPLICATE_PLAN_ITEM');
    for (const item of items) {
        identity(item.id); requireValue(Array.isArray(item.dependsOn) && item.dependsOn.length <= 100 && new Set(item.dependsOn).size === item.dependsOn.length, 'INVALID_DEPENDENCIES');
        requireValue(Object.keys(item.inputs ?? {}).length <= 100 && Array.isArray(item.outputs ?? []) && (item.outputs ?? []).length <= 100 && new Set(item.outputs ?? []).size === (item.outputs ?? []).length, 'PLAN_BINDING_LIMIT');
        for (const name of [...Object.keys(item.inputs ?? {}), ...(item.outputs ?? [])]) requireValue(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name), 'INVALID_OUTPUT_NAME');
        for (const binding of Object.values(item.inputs ?? {})) {
            requireValue(binding && item.dependsOn.includes(binding.fromItemId) && typeof binding.output === 'string', 'INPUT_DEPENDENCY_REQUIRED');
            const producer=items.find(other=>other.id===binding.fromItemId), existing=Object.values(state.workflow!.dispatches).some(dispatch=>dispatch.itemId===binding.fromItemId&&dispatch.outcome==='accepted'&&dispatch.outputs?.some(output=>output.name===binding.output));
            requireValue(producer ? producer.outputs?.includes(binding.output) : existing, 'OUTPUT_NOT_DECLARED');
        }
        requireValue(!item.dependsOn.some(id=>state.board.items.find(row=>row.id===id)?.restartPending),'DEPENDENCY_RESTART_PENDING');
        for (const dependency of item.dependsOn) requireValue(ids.has(dependency) || [...state.board.items,...(state.archiveIndex ?? [])].some(old => old.id === dependency), 'DEPENDENCY_NOT_FOUND');
    }
    const ordered: KanbanWorkDefinition[] = [], remaining = [...items], done = new Set<string>();
    while (remaining.length) {
        const next = remaining.findIndex(item => item.dependsOn.every(id => !ids.has(id) || done.has(id)));
        requireValue(next >= 0, 'DEPENDENCY_CYCLE'); const [item] = remaining.splice(next,1); ordered.push(item); done.add(item.id);
    }
    return ordered;
}
function validateDefinition(item: KanbanWorkDefinition): void {
    requireValue(item && typeof item === 'object' && !Array.isArray(item), 'INVALID_WORK_DEFINITION');
    const assignee=item.assignee;
    requireValue(assignee && ['agent','human','service'].includes(assignee.kind), 'INVALID_PRINCIPAL'); identity(assignee.id);
    if(item.inputs!==undefined) requireValue(item.inputs && typeof item.inputs==='object' && !Array.isArray(item.inputs), 'INVALID_INPUT_BINDINGS');
    if(item.outputs!==undefined) requireValue(Array.isArray(item.outputs) && item.outputs.every(name=>typeof name==='string'), 'INVALID_OUTPUT_NAMES');
}
