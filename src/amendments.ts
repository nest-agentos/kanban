import {plan} from './planning';
import {sha256HexSync} from './utils';
import type {KanbanActor, KanbanBoard, KanbanCommand, KanbanDiscoveryChange, KanbanItem, KanbanText} from './contracts';
import {identity, requireValue, text} from './rules';
import {principal, principalKey} from './identity';
export const textOf = (item: KanbanText): KanbanText => ({title: item.title, responsibility: item.responsibility, acceptance: item.acceptance});
export const textDigest = (item: KanbanText): string => sha256HexSync(JSON.stringify(textOf(item)));
export function workFingerprint(item: KanbanItem): string {
    const planning = plan(item);
    return sha256HexSync(JSON.stringify({text: textOf(item), kind: planning.kind, parentId: planning.parentId ?? null,
        area: planning.area ?? null, milestone: planning.milestone ?? null, priority: planning.priority,
        dependencies: [...planning.dependencies].sort(), dueAt: planning.dueAt ?? null}));
}
export function validateSources(sources: KanbanDiscoveryChange['sources']): void {
    requireValue(Array.isArray(sources) && sources.length <= 100, 'SOURCE_LIMIT');
    for (const source of sources) {
        identity(source.sessionId); identity(source.messageId); identity(source.revision);
        requireValue(source.role === 'user' || source.role === 'assistant', 'INVALID_SOURCE');
    }
}
export function proposeAmendment(item: KanbanItem, change: KanbanDiscoveryChange, actor: KanbanActor, now: number, runId: string): void {
    text(change.title); text(change.responsibility); text(change.acceptance); validateSources(change.sources);
    const proposed = textOf(change), fingerprint = textDigest(proposed);
    if (textDigest(item) === fingerprint || item.amendments?.some(p => p.fingerprint === fingerprint)) return;
    requireValue((item.amendments?.length ?? 0) < 20, 'AMENDMENT_LIMIT');
    (item.amendments ??= []).push({runId, id: `amendment-${sha256HexSync(JSON.stringify([runId, item.id, fingerprint]))}`, fingerprint,
        baseRevision: item.revision, baseDigest: textDigest(item), proposed, proposedBy: principal(actor), sources: structuredClone(change.sources),
        createdAt: now, status: 'pending'});
}
export function requireReviewer(board: KanbanBoard, actor: KanbanActor): void {
    const key = principalKey(principal(actor));
    requireValue(board.members?.some(m => principalKey(m) === key && m.roles?.some(role => role === 'coordinator' || role === 'reviewer')),
        'REVIEWER_REQUIRED');
}
export function reviewAmendment(board: KanbanBoard, command: Extract<KanbanCommand, {type: 'review-amendment'}>, actor: KanbanActor, now: number): void {
    requireReviewer(board, actor);
    const item = board.items.find(i => i.id === command.itemId), proposal = item?.amendments?.find(p => p.id === command.amendmentId);
    requireValue(item && proposal?.status === 'pending', 'AMENDMENT_NOT_PENDING');
    if (command.accept) {
        requireValue(principal(actor).kind === 'human' || principalKey(proposal.proposedBy) !== principalKey(principal(actor)), 'INDEPENDENT_REVIEW_REQUIRED');
        requireValue(['proposed', 'backlog', 'open'].includes(item.status), 'ITEM_NOT_PLANNABLE');
        requireValue(textDigest(item) === proposal.baseDigest, 'AMENDMENT_STALE');
        Object.assign(item, proposal.proposed);
        if (item.status === 'open') {item.status = 'backlog'; item.readyAt = now;}
    } else {requireValue(!!command.reason?.trim(), 'AMENDMENT_REASON_REQUIRED'); text(command.reason!);}
    proposal.status = command.accept ? 'accepted' : 'rejected'; proposal.reviewedAt = now; proposal.reviewedBy = principal(actor); proposal.reason = command.reason;
    item.updatedAt = now; item.revision++;
}
