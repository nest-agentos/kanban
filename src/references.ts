import {kanbanTaskType,kanbanReference, type KanbanReferenceTarget} from './contracts';
import type {KanbanReadView, KanbanStore} from './ports';
import {requireValue} from './rules';

export async function resolveReference(reference: string, store: KanbanStore, read: (id: string) => Promise<KanbanReadView>): Promise<KanbanReferenceTarget> {
    requireValue(typeof reference === 'string' && reference.length <= 100, 'INVALID_REFERENCE');
    const match = /^(?:KB-([1-9]\d*)(?:#([1-9]\d*)|\/(L|D)-([1-9]\d*))?|KB([DCTL])-([1-9]\d*)-([1-9]\d*))$/i.exec(reference.trim());
    requireValue(match && [match[1], match[2], match[4],match[6],match[7]].every(value => value === undefined || Number.isSafeInteger(Number(value))), 'INVALID_REFERENCE');
    const boardNumber=Number(match[1]??match[6]),number=Number(match[2]??match[4]??match[7]),type=(match[3]??match[5])?.toUpperCase();
    const id = await store.boardId?.(boardNumber); requireValue(id, 'REFERENCE_NOT_FOUND');
    const view = await read(id), board = view.state.board;
    requireValue(board.number === boardNumber, 'INVALID_NUMBERING');
    const target: KanbanReferenceTarget = {boardId: id, scope: board.scope, reference: kanbanReference(board)};
    if (match[2]||type==='C'||type==='T') {
        const item = [...view.items, ...(view.state.archiveIndex ?? [])].find(item => item.number === number&&(!type||kanbanTaskType(item)===(type==='C'?'coordination':'execution')));
        requireValue(item, 'REFERENCE_NOT_FOUND'); target.itemId = item.id; target.reference = kanbanReference(board, item);
    } else if (type) {
        const record = view.records.find(record => record.kind === (type === 'L' ? 'log' : 'decision') && record.number === number);
        requireValue(record, 'REFERENCE_NOT_FOUND'); target.recordId = record.id; target.reference = kanbanReference(board, record);
    }
    return target;
}
