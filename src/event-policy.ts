import type {KanbanEvent, KanbanBoard} from './contracts';
import {terminal} from './planning';
import {escalationReasons} from './reducer';

export function isKanbanEventRelevant(event: KanbanEvent, board: KanbanBoard, now: number): boolean {
    const item = board.items.find(i => i.id === event.itemId);
    if (event.kind === 'escalated') return !!item && !terminal(item) && (event.data.reason === 'transfer-timeout'
        ? !item.transfer && item.status === 'claimed' : escalationReasons(board, item, now).includes(event.data.reason ?? ''));
    if (event.kind === 'submit') return item?.status === 'review';
    if (event.kind === 'request-transfer') return !!item?.transfer && item.transfer.expiresAt > now;
    if (event.kind === 'publish-proposal') return item?.status === 'open';
    return true;
}
