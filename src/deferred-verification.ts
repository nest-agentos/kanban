import type {KanbanActor, KanbanBoard} from './contracts';
import type {KanbanVerificationCommand} from './contracts/deferred-verification';
import {identity, requireValue, text} from './rules';

export function updateDeferredVerification(board: KanbanBoard, command: KanbanVerificationCommand, actor: KanbanActor, now: number): void {
    requireValue(actor.kind === 'human', 'FORBIDDEN');
    requireValue(!board.lifecycle, 'BOARD_STOPPING');
    const queue = board.deferredVerifications ??= [];
    if (command.type === 'defer-verification') {
        const {id, title, instructions, itemId} = command.verification;
        identity(id); text(title); text(instructions);
        requireValue(title.length <= 160 && instructions.length <= 4000, 'INVALID_VERIFICATION');
        requireValue(!itemId || board.items.some(item => item.id === itemId && !item.deletedAt), 'ITEM_NOT_FOUND');
        requireValue(queue.length < 200 && !queue.some(entry => entry.id === id), 'VERIFICATION_QUEUE_LIMIT');
        queue.push({id, title, instructions, ...(itemId ? {itemId} : {}), actor, createdAt: now});
        return;
    }
    const entry = queue.find(row => row.id === command.verificationId);
    requireValue(entry && entry.result?.outcome !== 'passed', 'VERIFICATION_UNAVAILABLE');
    requireValue(command.outcome === 'passed' || command.outcome === 'failed', 'INVALID_VERIFICATION');
    text(command.evidence);
    requireValue(command.evidence.length <= 4000, 'INVALID_VERIFICATION');
    entry.result = {outcome: command.outcome, evidence: command.evidence, actor, verifiedAt: now};
}
