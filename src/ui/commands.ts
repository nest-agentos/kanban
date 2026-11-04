import type {KanbanBoardSummary, KanbanCommand, KanbanEstimate, KanbanItem, KanbanPlanning, KanbanPrincipal} from '../contracts';
import {randomUUID} from '../utils';
export const value = (data: FormData, key: string) => String(data.get(key) ?? '').trim();
export function readPlan(data: FormData, previous?: KanbanPlanning): KanbanPlanning {
    const area = value(data, 'area'), milestone = value(data, 'milestone'), parentId = value(data, 'parentId'), dueAt = value(data, 'dueAt');
    return {kind: value(data, 'kind'), ...(previous?.execution ? {execution:previous.execution} : {}), priority: Number(value(data, 'priority')), references: previous?.references ?? [],
        dependencies: [...new Set(data.getAll('dependencies').flatMap(value => String(value).split(',')).map(id => id.trim()).filter(Boolean))],
        ...(area ? {area} : {}), ...(milestone ? {milestone} : {}), ...(parentId ? {parentId} : {}), ...(dueAt ? {dueAt: new Date(dueAt).getTime()} : {})};
}
export function boardInput(data: FormData, actor: KanbanPrincipal, id: string) {
    return {id, title: value(data, 'title'), scope: {kind: 'system' as const},
        members: [{...actor, responsibility: 'Manage personal work', roles: ['worker', 'reviewer', 'coordinator'] as Array<'worker' | 'reviewer' | 'coordinator'>}],
        policy: {requireEstimate: data.has('requireEstimate'), review: 'assignee' as const}};
}
export function formCommand(kind: string, data: FormData, board: KanbanBoardSummary, item?: KanbanItem, id = randomUUID()): KanbanCommand {
    if (kind === 'item') return {type: 'create-item', ...(value(data, 'launchMode') ? {launch: {mode: value(data, 'launchMode') as 'automatic' | 'manual'}} : {}), item: {id, title: value(data, 'title'), responsibility: value(data, 'responsibility'), acceptance: value(data, 'acceptance'),...(value(data,'itemResource')?{externalRefs:[JSON.parse(value(data,'itemResource'))]}:{})}, planning: readPlan(data)};
    if (kind === 'record') {
        const sessionId = value(data, 'sourceSession'), messageId = value(data, 'sourceMessage'), revision = value(data, 'sourceRevision');
        if ([sessionId, messageId, revision].some(Boolean) && ![sessionId, messageId, revision].every(Boolean)) throw Object.assign(new Error('Missing source fields'), {code: 'SOURCE_FIELDS_REQUIRED'});
        return {type: 'append-record', record: {id, kind: value(data, 'kind') as 'log' | 'decision', title: value(data, 'title'), content: value(data, 'content'),
            externalRefs: data.getAll('recordResources').map(value => JSON.parse(String(value))),
            itemIds: [...new Set(data.getAll('itemIds').flatMap(value => String(value).split(',')).map(id => id.trim()).filter(Boolean))],
            sources: sessionId ? [{sessionId, messageId, revision, role: 'user'}] : [],
            ...(value(data, 'rationale') ? {rationale: value(data, 'rationale')} : {}), ...(value(data, 'supersedes') ? {supersedes: value(data, 'supersedes')} : {})}};
    }
    if (!item) throw new Error('ITEM_NOT_FOUND');
    const itemId = item.id, token = item.owner?.token ?? '';
    if (kind === 'edit-item') return {type: 'edit-item', itemId, title: value(data, 'title'), responsibility: value(data, 'responsibility'), acceptance: value(data, 'acceptance')};
    if (kind === 'amendment') return {type: 'review-amendment', itemId, amendmentId: value(data, 'amendmentId'), accept: value(data, 'decision') === 'accept', reason: value(data, 'reason') || undefined};
    if (kind === 'claim') return {type: 'claim', itemId, ...(board.policy.requireEstimate !== false ? {estimate: estimate(data)} : {})};
    if (kind === 'close-plan') return {type: 'close-plan', itemId, resultRef: value(data, 'resultRef')};
    if (kind === 'submit') return {type: 'submit', itemId, token, resultRef: value(data, 'resultRef')};
    if (kind === 'plan') return {type: 'plan-item', itemId, planning: readPlan(data, item.planning)};
    if (kind === 'cancel') return {type: 'cancel-item', itemId, reason: value(data, 'reason')};
    if (kind === 'release') return {type: 'release-item', itemId, token, next: 'backlog', reason: value(data, 'reason')};
    if (kind === 'block') return {type: 'block-item', itemId, token, reason: value(data, 'reason')};
    if (kind === 'session') return {type: 'register-session', itemId, sessionId: value(data, 'sessionId'), role: 'observer', subscribed: true};
    if (kind === 'message') return {type: 'message', itemId, message: value(data, 'message'), recipientSessionIds: item.participants.filter(p => p.subscribed).map(p => p.sessionId)};
    throw new Error('UNKNOWN_COMMAND');
}
function estimate(data: FormData): KanbanEstimate {
    return {complexity: Number(value(data, 'complexity')), workUnits: Number(value(data, 'workUnits')), durationMs: Number(value(data, 'duration')) * 60000, confidence: value(data, 'confidence') as KanbanEstimate['confidence']};
}
export function actionCommand(action: string, item: KanbanItem): KanbanCommand {
    const itemId = item.id, token = item.owner?.token ?? '';
    if (action === 'ready' || action === 'defer') return {type: 'set-stage', itemId, stage: action === 'ready' ? 'open' : 'backlog'};
    if (action === 'publish') return {type: 'publish-proposal', itemId};
    if (action === 'renew') return {type: 'renew', itemId, token};
    if (action === 'accept' || action === 'reject') return {type: 'review', itemId, accept: action === 'accept'};
    if (action === 'archive') return {type: 'archive-items', itemIds: [itemId], reason: 'manual'};
    if (action === 'restore') return {type: 'restore-item', itemId};
    if (action === 'unblock') return {type: 'unblock-item', itemId, token};
    throw new Error('UNKNOWN_COMMAND');
}
