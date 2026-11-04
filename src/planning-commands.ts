import {assertDefinitionEditable} from './task-commands';
import type {KanbanActor, KanbanCommand, KanbanExternalReference, KanbanItem} from './contracts';
import type {KanbanState} from './ports';
import {requireValue, text, identity, owned} from './rules';
import {catalog, setStage, terminal, validatePlan} from './planning';
import {executable} from './configuration';
import {archiveItems, restoreItem} from './archives';

type OperationalCommand = Extract<KanbanCommand, {type: 'block-item' | 'unblock-item' | 'link-reference' | 'release-item'}>;
type PlanCommand = Extract<KanbanCommand, {type: 'edit-item' | 'plan-item' | 'set-stage' | 'publish-proposal' | 'cancel-item' | 'close-plan'}>;
export type PlanningCommand = PlanCommand | OperationalCommand | Extract<KanbanCommand, {type: 'archive-items' | 'restore-item'}>;
export function planningCommand(command: KanbanCommand): command is PlanningCommand {
    return ['edit-item', 'plan-item', 'set-stage', 'publish-proposal', 'cancel-item', 'close-plan', 'archive-items', 'restore-item', 'block-item', 'unblock-item', 'link-reference', 'release-item'].includes(command.type);
}
export function applyPlanningCommand(state: KanbanState, command: PlanningCommand, now: number, actor: KanbanActor, internal = false): void {
    if (command.type === 'archive-items') return archiveItems(state, command.itemIds, command.reason, now);
    if (command.type === 'restore-item') return restoreItem(state, command.itemId, now);
    const item = state.board.items.find(i => i.id === command.itemId); requireValue(item, 'ITEM_NOT_FOUND');
    if (isOperational(command)) operate(item, command, now, actor);
    else {
        if (!internal && ['edit-item','plan-item','review-amendment'].includes(command.type)) assertDefinitionEditable(item, now);
        updatePlan(state, item, command, now);
    }
}
function isOperational(command: PlanCommand | OperationalCommand): command is OperationalCommand {
    return ['block-item', 'unblock-item', 'link-reference', 'release-item'].includes(command.type);
}
function operate(item: KanbanItem, command: OperationalCommand, now: number, actor: KanbanActor): void {
    if (command.type === 'release-item') {
        requireValue(['claimed', 'review'].includes(item.status) && item.owner?.token === command.token, 'OWNER_MISMATCH');
        requireValue(['backlog', 'cancelled'].includes(command.next), 'INVALID_STAGE'); text(command.reason);
        item.status = command.next;
        if (command.next === 'cancelled') {item.closedAt = now; item.closureReason = command.reason;}
        delete item.owner; delete item.transfer; delete item.estimate;
    } else if (command.type === 'link-reference') attachReference(item, command.reference);
    else {
        requireValue(!terminal(item), 'ITEM_COMPLETED');
        if (item.status === 'claimed') owned(item, actor, command.token ?? '', now);
        if (command.type === 'block-item') {text(command.reason); item.blocked = {reason: command.reason, at: now};}
        else delete item.blocked;
    }
    item.updatedAt = now; item.revision++;
}
function updatePlan(state: KanbanState, item: KanbanItem, command: PlanCommand, now: number): void {
    if(command.type==='cancel-item')requireValue(item.launch?.admittedAt===undefined,'TASK_CONTROL_REQUIRED');
    if (command.type === 'publish-proposal') {
        requireValue(item.status === 'proposed', 'NOT_PROPOSED'); return setStage(state, item, command.stage ?? 'backlog', now);
    }
    if (command.type === 'set-stage') return setStage(state, item, command.stage, now);
    requireValue(['proposed', 'backlog', 'open'].includes(item.status), 'ITEM_NOT_PLANNABLE');
    if (command.type === 'edit-item') {
        text(command.title); text(command.responsibility); text(command.acceptance);
        item.title = command.title; item.responsibility = command.responsibility; item.acceptance = command.acceptance;
        if (item.status === 'open') return setStage(state, item, 'backlog', now);
    } else if (command.type === 'plan-item') {
        validatePlan(state, item, command.planning); item.planning = command.planning;
        if (item.status === 'open') return setStage(state, item, 'backlog', now);
    } else {
        requireValue(catalog(state).filter(i => i.planning.parentId === item.id).every(terminal), 'CHILDREN_UNFINISHED');
        if (command.type === 'close-plan') {
            requireValue(!executable(state.board, item), 'TASK_REQUIRES_REVIEW'); text(command.resultRef);
            const children=catalog(state).filter(child=>child.planning.parentId===item.id);
            if(item.planning?.execution==='children')requireValue(children.length>0&&children.every(child=>child.status==='completed'),'CHILDREN_UNFINISHED');
            item.status = 'completed'; item.resultRef = command.resultRef;
        } else {text(command.reason); item.status = 'cancelled'; item.closureReason = command.reason;}
        item.closedAt = now;
    }
    item.updatedAt = now; item.revision++;
}
export function attachReference(item: KanbanItem, reference: KanbanExternalReference): void {
    identity(reference.system); identity(reference.id); if (reference.revision !== undefined) text(reference.revision);
    item.externalRefs ??= [];
    if (item.externalRefs.some(r => r.system === reference.system && r.id === reference.id && r.revision === reference.revision)) return;
    requireValue(item.externalRefs.length < 100, 'REFERENCE_LIMIT'); item.externalRefs.push(reference);
}
