import {sha256HexSync} from './utils';
import type {KanbanActor, KanbanCommand, KanbanProjectRecord, KanbanRecordPage, KanbanRecordQuery} from './contracts';
import type {KanbanState} from './ports';
import {identity, requireValue, text} from './rules';
import {principal, principalKey} from './identity';
import {requireReviewer, validateSources} from './amendments';
export type RecordCommand = Extract<KanbanCommand, {type: 'append-record' | 'review-record' | 'link-record'}>;
export function isRecordCommand(command: KanbanCommand): command is RecordCommand {
    return ['append-record', 'review-record', 'link-record'].includes(command.type);
}
export function applyRecord(state: KanbanState, command: RecordCommand, actor: KanbanActor, now: number, forceDraft = false): void {
    if (command.type === 'append-record') {append(state, command, actor, now, forceDraft); return;}
    const record = state.records?.find(record => record.id === command.recordId); requireValue(record, 'RECORD_NOT_FOUND');
    if (command.type === 'link-record') {
        validateItems(state, [command.itemId]);
        if (!record.itemIds.includes(command.itemId)) {requireValue(record.itemIds.length < 100, 'RECORD_LINK_LIMIT'); record.itemIds.push(command.itemId);}
    } else {
        requireReviewer(state.board, actor); requireValue(record.status === 'draft', 'RECORD_NOT_DRAFT');
        if (command.accept) {
            requireValue(principal(actor).kind === 'human' || principalKey(record.author) !== principalKey(principal(actor)), 'INDEPENDENT_REVIEW_REQUIRED');
            supersede(state, record, now); record.status = 'confirmed';
        } else record.status = 'rejected';
        record.reviewedBy = principal(actor);
    }
    record.updatedAt = now; record.revision++;
}
function append(state: KanbanState, command: Extract<RecordCommand, {type: 'append-record'}>, actor: KanbanActor, now: number, forceDraft: boolean): void {
    validateSources(command.record.sources);
    const {id, kind, title, content, rationale, itemIds, sources, supersedes, coordination, externalRefs} = command.record;
    const input = structuredClone({id, kind, title, content, rationale, itemIds, sources: sources.map(source => ({sessionId: source.sessionId, messageId: source.messageId, revision: source.revision, role: source.role})), supersedes, ...(coordination ? {coordination}: {}), ...(externalRefs ? {externalRefs} : {})}); identity(input.id); text(input.title); text(input.content);
    validateRecordReferences(externalRefs);
    requireValue(input.kind === 'log' || input.kind === 'decision', 'INVALID_RECORD_KIND');
    requireValue(!state.records?.some(record => record.id === input.id), 'RECORD_EXISTS');
    requireValue((state.records?.length ?? 0) < 200, 'RECORD_LIMIT'); validateItems(state, input.itemIds); validateSources(input.sources);
    if (input.rationale !== undefined) text(input.rationale);
    if (input.kind === 'decision') text(input.rationale ?? '');
    if (coordination) validateCoordination(state, input);
    if (input.supersedes) {identity(input.supersedes); requireValue(input.kind === 'decision' && input.supersedes !== input.id
        && state.records?.some(record => record.id === input.supersedes && record.kind === 'decision' && record.status === 'confirmed'), 'INVALID_SUPERSEDED_RECORD');}
    const author = principal(actor), manual = author.kind === 'human' && !forceDraft;
    (state.records ??= []).push({...input, author, origin: manual ? 'manual' : 'flow',
        status: manual && input.kind === 'log' ? 'confirmed' : 'draft', revision: 1, createdAt: now, updatedAt: now});
}
function validateCoordination(state: KanbanState, input: import('./contracts').KanbanRecordInput): void {
    requireValue(input.kind === 'decision', 'DECISION_COORDINATION_ONLY');
    for (const owner of [input.coordination!.manager, input.coordination!.executor].filter(Boolean)) {
        requireValue(owner && ['agent','human','service'].includes(owner.kind), 'INVALID_PRINCIPAL');identity(owner.id);
        const member=state.board.members?.find(member=>principalKey(member)===principalKey(owner));
        requireValue(member, 'ASSIGNEE_NOT_REGISTERED');
        if(owner===input.coordination!.manager) requireValue(member.roles?.includes('coordinator'), 'COORDINATOR_REQUIRED');
    }
}
function validateItems(state: KanbanState, ids: string[]): void {
    requireValue(Array.isArray(ids) && ids.length <= 100 && new Set(ids).size === ids.length, 'RECORD_LINK_LIMIT');
    for (const id of ids) {identity(id); requireValue(state.board.items.some(item => item.id === id) || state.archiveIndex?.some(item => item.id === id), 'ITEM_NOT_FOUND');}
}
function supersede(state: KanbanState, record: KanbanProjectRecord, now: number): void {
    if (!record.supersedes) return;
    const previous = state.records?.find(entry => entry.id === record.supersedes);
    requireValue(previous?.kind === 'decision' && previous.status === 'confirmed', 'SUPERSEDED_RECORD_CHANGED');
    previous.status = 'superseded'; previous.supersededBy = record.id; previous.revision++; previous.updatedAt = now;
}
export function queryRecords(state: KanbanState, query: KanbanRecordQuery = {}, summaries = (state.records ?? []).map(recordSummary)): KanbanRecordPage {
    const {cursor, ...filter} = query, limit = query.limit ?? 50;
    requireValue(Number.isSafeInteger(limit) && limit > 0 && limit <= 200, 'INVALID_LIMIT');
    if (query.kind) requireValue(['log', 'decision'].includes(query.kind), 'INVALID_RECORD_KIND');
    if (query.itemId !== undefined) identity(query.itemId);
    if (query.status) requireValue(['draft', 'confirmed', 'rejected', 'superseded'].includes(query.status), 'INVALID_RECORD_STATUS');
    const digest = sha256HexSync(JSON.stringify(filter)); let offset = 0;
    if (cursor) {
        let decoded; try {decoded = JSON.parse(decodeURIComponent(cursor));} catch {requireValue(false, 'INVALID_CURSOR');}
        requireValue(decoded && typeof decoded === 'object' && !Array.isArray(decoded) && typeof decoded.filter === 'string'
            && typeof decoded.revision === 'number', 'INVALID_CURSOR');
        requireValue(decoded.revision === state.board.revision && decoded.filter === digest, 'CURSOR_STALE');
        offset = decoded.offset; requireValue(Number.isSafeInteger(offset) && offset >= 0, 'INVALID_CURSOR');
    }
    const matched = summaries.filter(record => (!query.kind || query.kind === record.kind)
        && (!query.itemId || record.itemIds.includes(query.itemId)) && (!query.status || query.status === record.status))
        .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    const items = matched.slice(offset, offset + limit);
    return {revision: state.board.revision, total: matched.length, items, ...(offset + limit < matched.length
        ? {nextCursor: encodeURIComponent(JSON.stringify({revision: state.board.revision, filter: digest, offset: offset + limit}))} : {})};
}

export function recordFingerprint(record: import('./contracts').KanbanRecordInput): string {
    return sha256HexSync(JSON.stringify({kind: record.kind, title: record.title, content: record.content, rationale: record.rationale ?? null,
        itemIds: [...record.itemIds].sort(), sources: record.sources.map(source => JSON.stringify([source.sessionId, source.messageId, source.role])).sort(), ...(record.coordination?{coordination:record.coordination}: {}), ...(record.externalRefs ? {externalRefs: record.externalRefs} : {})}));
}

function validateRecordReferences(refs: import('./contracts').KanbanExternalReference[] | undefined): void {
    if (refs === undefined) return;
    requireValue(Array.isArray(refs) && refs.length <= 100, 'REFERENCE_LIMIT');
    const keys = new Set<string>();
    for (const ref of refs) {
        requireValue(ref && typeof ref === 'object', 'INVALID_REFERENCE');
        identity(ref.system); identity(ref.id); if (ref.revision !== undefined) text(ref.revision);
        const key = JSON.stringify([ref.system, ref.id]);
        requireValue(!keys.has(key), 'DUPLICATE_REFERENCE'); keys.add(key);
    }
}

export function recordSummary(record: KanbanProjectRecord): import('./contracts').KanbanRecordSummary {
    const {content: _content, rationale: _rationale, sources, ...metadata} = record;
    return {...metadata, sessionIds: [...new Set(sources.map(source => source.sessionId))]};
}
