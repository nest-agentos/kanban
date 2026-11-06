import type {KanbanActor, KanbanCommand} from './contracts';
import type {KanbanState} from './ports';
import {identity, requireValue} from './rules';
import {principal} from './identity';

/** Restart creates a successor; sealed plans and native execution identities remain historical. */
export function restartItemInput(state: KanbanState, command: Extract<KanbanCommand, {type:'restart-item'}>, actor: KanbanActor, inherit?: import('./ports').KanbanModuleOptions['restartReferences']): Extract<KanbanCommand, {type:'create-item'}> {
    requireValue(principal(actor).kind === 'human', 'FORBIDDEN'); identity(command.replacementId);
    requireValue(!state.board.items.some(item=>item.planning?.dependencies.includes(command.itemId)),'DEPENDENCY_RESTART_REQUIRED');
    const previous = state.board.items.find(item => item.id === command.itemId);
    requireValue(previous, 'ITEM_NOT_FOUND');
    requireValue(previous.status === 'cancelled', 'TASK_NOT_CANCELLED');
    requireValue(!previous.owner && !previous.transfer && (!previous.control || previous.control.state === 'cancelled'), 'CONTROL_UNSETTLED');
    requireValue(Object.values(state.workflow?.dispatches ?? {}).filter(dispatch => dispatch.itemId === previous.id)
        .every(dispatch => ['failed','cancelled'].includes(dispatch.outcome)), 'EXECUTION_UNSETTLED');
    requireValue(!state.board.items.some(item => item.planning?.parentId === previous.id && !['completed','cancelled'].includes(item.status)), 'CHILDREN_UNFINISHED');
    const {title, responsibility, acceptance, eligibleAgentIds, eligiblePrincipals, externalRefs} = previous;
    const refs = inherit?.(structuredClone(externalRefs ?? [])) ?? [];
    requireValue(refs.every(ref => externalRefs?.some(old => old.system === ref.system && old.id === ref.id && old.revision === ref.revision)), 'RESTART_REFERENCE_CHANGED');
    const planning = previous.planning ? structuredClone(previous.planning) : undefined;
    if (planning) delete planning.execution;
    return {type:'create-item',item:{id:command.replacementId,title,responsibility,acceptance,eligibleAgentIds,eligiblePrincipals,externalRefs:structuredClone(refs)},
        planning,launch:{mode:'manual'}};
}
