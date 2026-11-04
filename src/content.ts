import type {KanbanActor, KanbanCommand, KanbanContent, KanbanContentItem} from './contracts';
import type {KanbanModuleOptions, KanbanState, KanbanStore} from './ports';
import {createBoardState} from './board';
import {normalizeActor} from './identity';
import {identity, requireValue} from './rules';
import {reduce} from './reducer';
import {proposeAmendment} from './amendments';
import {randomUUID} from './utils';

export interface KanbanContentOptions extends KanbanModuleOptions {
    content: KanbanContent;
    operationId: string;
    fillMissing?: boolean;
    missingReferences?: 'reject' | 'detach';
}
export async function inspectKanbanContent(store: KanbanStore, content: KanbanContent) {
    const state = await store.read(content.board.id);
    const ids = new Set([...state?.board.items ?? [], ...state?.archiveIndex ?? []].map(item => item.id));
    return {version: state?.presetVersions?.[content.id] ?? 0,
        complete: !!state && content.items.every(item => ids.has(item.command.item.id)) && (content.records ?? []).every(entry => state.records?.some(record => record.id === entry.record.id))};
}

/** Authorized bootstrap/import: domain changes and the installed version commit together. */
export async function installKanbanContent(options: KanbanContentOptions): Promise<{changed: boolean; created: number}> {
    const started = (options.now ?? Date.now)(), content = structuredClone(options.content);
    try {
        identity(content.id); identity(options.operationId);
        validateContent(content);
        const actor = normalizeActor(options.actor), before = await options.store.read(content.board.id);
        const initial = before ?? createBoardState(content.board, actor, started);
        await options.authorize({actor, board: structuredClone(initial.board), action: 'install-content'});
        const result = {changed: false, created: 0};
        if (before && !options.fillMissing && (before.presetVersions?.[content.id] ?? 1) >= content.version) {report(options, started, 'success'); return result;}
        await options.store.update(content.board.id, options.operationId, JSON.stringify({content, actor, fillMissing: !!options.fillMissing, missingReferences: options.missingReferences}), current => {
            requireValue(JSON.stringify(current) === JSON.stringify(before), 'REVISION_CONFLICT');
            if (current?.board.deletedAt !== undefined) {requireValue(!options.fillMissing, 'BOARD_DELETED'); return current;}
            const installed = current?.presetVersions?.[content.id] ?? (current ? 1 : 0);
            if (current && !options.fillMissing && installed >= content.version) return current;
            const state = current ?? initial; result.changed = !current;
            applyContent(state, {...options, content}, actor, installed, started, result);
            (state.presetVersions ??= {})[content.id] = content.version;
            return state;
        });
        report(options, started, 'success'); return result;
    } catch (error) {
        const raw = (error as {code?: unknown})?.code;
        report(options, started, 'failure', typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : 'CONTENT_INSTALL_FAILED');
        throw error;
    }
}
function validateContent(content: KanbanContent): void {
    requireValue(Number.isSafeInteger(content.version) && content.version > 0, 'INVALID_CONTENT_VERSION');
    requireValue(Array.isArray(content.items) && content.items.length <= 1000, 'CONTENT_ITEM_LIMIT');
    for (const rows of [content.records, content.amendments]) requireValue(rows === undefined || Array.isArray(rows) && rows.length <= 1000, 'CONTENT_RECORD_LIMIT');
    for (const entry of [...content.items, ...content.records ?? [], ...content.amendments ?? []]) {
        const version = entry.introduced ?? 1;
        requireValue(Number.isSafeInteger(version) && version > 0 && version <= content.version, 'INVALID_CONTENT_VERSION');
    }
}
function applyContent(state: KanbanState, options: KanbanContentOptions, actor: KanbanActor, installed: number, now: number, result: {changed: boolean; created: number}): void {
    const content = options.content, version = options.fillMissing ? 0 : installed;
    const known = new Set([...state.board.items, ...state.archiveIndex ?? []].map(item => item.id));
    const apply = (command: KanbanCommand) => reduce(state, command, actor, options.operationId, now, (options.id ?? randomUUID)());
    for (const entry of content.items) {
        if (known.has(entry.command.item.id) || (entry.introduced ?? 1) <= version) continue;
        insertItem(state, entry, options.missingReferences === 'detach', apply);
        known.add(entry.command.item.id); result.changed = true; result.created++;
    }
    for (const entry of content.records ?? []) {
        if ((entry.introduced ?? 1) <= version || state.records?.some(record => record.id === entry.record.id)) continue;
        const record = structuredClone(entry.record);
        if (options.missingReferences === 'detach') record.itemIds = record.itemIds.filter(id => known.has(id));
        apply({type: 'append-record', record});
        if (entry.confirmed) apply({type: 'review-record', recordId: record.id, accept: true});
        result.changed = true;
    }
    for (const entry of content.amendments ?? []) {
        if ((entry.introduced ?? 1) <= version) continue;
        const item = state.board.items.find(item => item.id === entry.itemId); if (!item) continue;
        const count = item.amendments?.length ?? 0;
        // Imported attribution grants no authority to execute or review work.
        proposeAmendment(item, {action: 'update', ...entry, sources: []}, entry.proposedBy, now, entry.runId);
        if ((item.amendments?.length ?? 0) > count) {item.revision++; state.board.revision++; result.changed = true;}
    }
}
function insertItem(state: KanbanState, entry: KanbanContentItem, detach: boolean, apply: (command: KanbanCommand) => void): void {
    const command = structuredClone(entry.command), parentId = command.planning?.parentId;
    if (detach && parentId) {
        const parent = state.board.items.find(item => item.id === parentId);
        if (!parent || ['completed', 'cancelled'].includes(parent.status)) delete command.planning!.parentId;
    }
    const itemId = command.item.id;
    apply(command);
    if (entry.blocked) apply({type: 'block-item', itemId, reason: entry.blocked});
    if (entry.completion) {
        apply({type: 'close-plan', itemId, resultRef: entry.completion.resultRef});
        if (entry.completion.archiveReason) apply({type: 'archive-items', itemIds: [itemId], reason: entry.completion.archiveReason});
    }
}
function report(options: KanbanContentOptions, start: number, result: 'success' | 'failure', code?: string): void {
    try {options.log({operationId: options.operationId, boardId: options.content.board.id, stage: 'content.install', result, code, durationMs: (options.now ?? Date.now)() - start});}
    catch { /* Diagnostics cannot undo content installation. */ }
}
