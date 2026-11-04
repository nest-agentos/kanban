import type {KanbanArchivedItem} from './contracts';
import type {KanbanState} from './ports';
import {requireValue, text} from './rules';
import {summary, terminal} from './planning';

export function archiveItems(state: KanbanState, ids: string[], reason: string, now: number): void {
    text(reason); requireValue(ids.length > 0 && ids.length <= 50 && new Set(ids).size === ids.length, 'ARCHIVE_BATCH_LIMIT');
    const items = ids.map(id => state.board.items.find(i => i.id === id));
    requireValue(items.every(item => item && terminal(item)), 'ARCHIVE_REQUIRES_CLOSED_ITEM');
    for (const item of items) {
        const archived: KanbanArchivedItem = {item: item!, archivedAt: now, reason};
        (state.archiveIndex ??= []).push({...summary(item!), archivedAt: now, archiveReason: reason});
        (state.archiveWrites ??= []).push({id: item!.id, value: archived});
    }
    const selected = new Set(ids); state.board.items = state.board.items.filter(i => !selected.has(i.id));
}
export function restoreItem(state: KanbanState, id: string, now: number): void {
    const record = state.restore;
    requireValue(record?.item.id === id && state.archiveIndex?.some(i => i.id === id), 'ARCHIVED_ITEM_NOT_FOUND');
    requireValue(!state.board.items.some(i => i.id === id), 'ITEM_EXISTS');
    record.item.restoredAt = now; record.item.updatedAt = now; record.item.revision++; state.board.items.push(record.item);
    state.archiveIndex = state.archiveIndex!.filter(i => i.id !== id);
    (state.archiveWrites ??= []).push({id, value: null}); delete state.restore;
}
export function archiveExpired(state: KanbanState, now: number): string[] {
    const age = state.board.policy.archiveAfterMs;
    if (age === undefined) return [];
    const ids = state.board.items.filter(i => terminal(i) && now - Math.max(i.closedAt ?? i.updatedAt, i.restoredAt ?? 0) >= age).slice(0, 50).map(i => i.id);
    if (ids.length) archiveItems(state, ids, 'retention-policy', now);
    return ids;
}
