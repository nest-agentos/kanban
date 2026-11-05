import {sha256HexSync} from '../utils';
import type {KanbanAutomationJournal} from './automation-journal';
import type {TaskControlPorts} from './task-controls';
interface FrozenReply {phase?:string;sessionId:string;request:{itemId:string;operationId:string}}
import {requireValue} from '../rules';

/** Freeze out later delivery before reconciling an already admitted reply in its original Session. */
export async function cancelTaskReplies(options: TaskControlPorts, journal: KanbanAutomationJournal, board: string, item: string, controlId: string): Promise<'cancelled' | 'accepted' | 'unknown'> {
    const replies = await journal.findForBoard<FrozenReply>('task-reply:', board, reply => reply.request.itemId === item);
    for (const row of replies) {
        const id = row.value.request.operationId;
        if (await journal.get('task-reply-cancelled:' + id)) continue;
        const saved = await journal.update<FrozenReply>(row.key, old => ({...old!,phase:old!.phase === 'prepared' ? 'cancelled' : old!.phase === 'cancelled' ? 'cancelled' : 'cancelling'}));
        if (saved.phase !== 'cancelled') {
            requireValue(options.control, 'TASK_CONTROL_UNSUPPORTED');
            const state = await options.control.control({executionId:saved.sessionId,attemptId:id,operationId:sha256HexSync(JSON.stringify([controlId,id])),action:'cancel',kind:'submission'});
            if (state !== 'cancelled') return state === 'unknown' ? 'unknown' : 'accepted';
        }
        await journal.update('task-reply-cancelled:' + id, () => true);
    }
    return 'cancelled';
}
