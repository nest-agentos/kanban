import {TASK_START_DELAY_MS} from './contracts/task-projection';
import {discoveryState} from './discovery-state';
import {applyRecord, recordFingerprint} from './project-records';
import {principal, principalKey} from './identity';
import {workFingerprint, proposeAmendment, validateSources} from './amendments';
import type {KanbanActor, KanbanDiscoveryBatch, KanbanDiscoveryChange, KanbanItem} from './contracts';
import type {KanbanState} from './ports';
import {executable} from './configuration';
import {validateCandidates} from './identity';
import {plan, setStage, validatePlan, automaticStage} from './planning';
import {identity, participant, requireValue, text} from './rules';

/** Commit accepted changes and source watermarks in the same board transaction. */
export function applyDiscovery(state: KanbanState, batch: KanbanDiscoveryBatch, actor: KanbanActor, now: number): void {
    const discovery = discoveryState(state), pending = discovery?.pending;
    requireValue(pending && pending.runId === batch.runId && pending.token === batch.leaseToken && pending.leaseUntil > now, 'SCAN_LEASE_EXPIRED');
    requireValue(pending.request?.command.type === 'apply-discovery' && JSON.stringify(pending.request.command.batch) === JSON.stringify(batch), 'SCAN_BATCH_MISMATCH');
    requireValue(batch.changes.length <= 50, 'SCAN_CHANGE_LIMIT');
    for (const change of batch.changes) {
        identity(change.itemId); validateSources(change.sources);
        requireValue(change.sources.length > 0 && change.sources.some(s => s.role === 'user'), 'USER_EVIDENCE_REQUIRED');
        const item = change.action === 'create' ? createItem(state, change, actor, now, batch.autoCreate, batch.runId) : updateItem(state, change, actor, now, batch.runId);
        if (item) attachSources(item, change, now);
    }
    requireValue((batch.records?.length ?? 0) <= 20, 'SCAN_RECORD_LIMIT');
    for (const record of batch.records ?? []) {
        requireValue(record.sources.some(source => source.role === 'user'), 'USER_EVIDENCE_REQUIRED');
        const duplicate = state.records?.some(old => recordFingerprint(old) === recordFingerprint(record));
        if (!duplicate) {applyRecord(state, {type: 'append-record', record}, actor, now, true); state.records!.find(entry => entry.id === record.id)!.originRunId = batch.runId;}
    }
    for (const checkpoint of batch.checkpoints) discovery!.checkpoints[checkpoint.sessionId] = checkpoint.revision;
    discovery!.lastRun = {runId: batch.runId, outcome: 'committed', at: now};
    delete discovery!.pending;
}
function createItem(state: KanbanState, change: KanbanDiscoveryChange, actor: KanbanActor, now: number, autoCreate: boolean, runId: string): KanbanItem | undefined {
    text(change.title); text(change.responsibility); text(change.acceptance);
    const item: KanbanItem = {origin: {kind: 'discovery', principal: principal(actor), runId}, id: change.itemId, title: change.title, responsibility: change.responsibility, acceptance: change.acceptance,
        eligibleAgentIds: change.eligibleAgentIds, eligiblePrincipals: change.eligiblePrincipals, status: 'proposed', revision: 1,
        createdAt: now, readyAt: now, updatedAt: now, workUnits: 0, participants: [], sources: []};
    item.launch={startAt:now+TASK_START_DELAY_MS};
    item.planning = change.planning ?? {...plan(item), kind: state.board.defaultWorkType ?? 'task'};
    const fingerprint = workFingerprint(item); item.origin!.fingerprint = fingerprint;
    validateCandidates(state.board, item, executable(state.board, item));
    if (state.archiveIndex?.some(old => old.discoveryFingerprint === fingerprint)) return undefined;
    const existing = state.board.items.find(old => workFingerprint(old) === fingerprint || old.origin?.fingerprint === fingerprint);
    if (existing) {existing.revision++; existing.updatedAt = now; return existing;}
    requireValue(!state.board.items.some(old => old.id === change.itemId) && !state.archiveIndex?.some(old => old.id === change.itemId), 'ITEM_EXISTS');
    validatePlan(state, item, item.planning); state.board.items.push(item);
    if (autoCreate) setStage(state, item, automaticStage(state, item), now);
    if (actor.sessionId) participant(item.participants, actor.sessionId, actor.agentId, 'creator', true, now);
    return item;
}
function updateItem(state: KanbanState, change: KanbanDiscoveryChange, actor: KanbanActor, now: number, runId: string): KanbanItem {
    const item = state.board.items.find(i => i.id === change.itemId); requireValue(item, 'ITEM_NOT_FOUND');
    if (change.action === 'update') {
        requireValue(!change.planning, 'SCAN_PLANNING_REQUIRES_REVIEW');
        const ownDraft = item.status === 'proposed' && item.origin?.kind === 'discovery'
            && principalKey(item.origin.principal) === principalKey(principal(actor));
        if (ownDraft) {
            text(change.title); text(change.responsibility); text(change.acceptance);
            item.title = change.title; item.responsibility = change.responsibility; item.acceptance = change.acceptance;
        } else proposeAmendment(item, change, actor, now, runId);
    } else requireValue(change.action === 'link', 'INVALID_CHANGE');
    item.revision++; item.updatedAt = now; return item;
}
function attachSources(item: KanbanItem, change: KanbanDiscoveryChange, now: number): void {
    for (const source of change.sources) {
        const subscribed = item.participants.find(p => p.sessionId === source.sessionId)?.subscribed ?? false;
        participant(item.participants, source.sessionId, undefined, source.role === 'user' ? 'creator' : 'consultant', subscribed, now);
        item.sources ??= [];
        if (!item.sources.some(s => s.sessionId === source.sessionId && s.messageId === source.messageId && s.revision === source.revision)) item.sources.push(source);
    }
}
