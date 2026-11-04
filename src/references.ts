import {kanbanReference, type KanbanReferenceTarget} from './contracts';
import type {KanbanReadView, KanbanStore} from './ports';
import {requireValue} from './rules';

export async function resolveReference(reference: string, store: KanbanStore, read: (id: string) => Promise<KanbanReadView>): Promise<KanbanReferenceTarget> {
    requireValue(typeof reference === 'string' && reference.length <= 100, 'INVALID_REFERENCE');
    const match = /^KB-([1-9]\d*)(?:#([1-9]\d*)|\/(L|D)-([1-9]\d*))?$/i.exec(reference.trim());
    requireValue(match && [match[1], match[2], match[4]].every(value => value === undefined || Number.isSafeInteger(Number(value))), 'INVALID_REFERENCE');
    const id = await store.boardId?.(Number(match[1])); requireValue(id, 'REFERENCE_NOT_FOUND');
    const view = await read(id), board = view.state.board;
    requireValue(board.number === Number(match[1]), 'INVALID_NUMBERING');
    const target: KanbanReferenceTarget = {boardId: id, scope: board.scope, reference: kanbanReference(board)};
    if (match[2]) {
        const item = [...view.items, ...(view.state.archiveIndex ?? [])].find(item => item.number === Number(match[2]));
        requireValue(item, 'REFERENCE_NOT_FOUND'); target.itemId = item.id; target.reference = kanbanReference(board, item);
    } else if (match[3]) {
        const record = view.records.find(record => record.kind === (match[3].toUpperCase() === 'L' ? 'log' : 'decision') && record.number === Number(match[4]));
        requireValue(record, 'REFERENCE_NOT_FOUND'); target.recordId = record.id; target.reference = kanbanReference(board, record);
    }
    return target;
}
