import type {KanbanAutomationJournal} from './automation-journal';
import type {TaskControlPorts} from './task-controls';
interface ReviewJob {id:string;boardId:string;itemId:string;phase:string;action:string;state:string;code?:string;sessionId?:string;input?:unknown;request?:unknown}
import {controlExecution as controlCall} from './control';
import {requireValue} from '../rules';
import {sha256HexSync} from '../utils';

/** Submission claims and definite no-start cancellation compete in the original journal transaction. */
export async function cancelTaskMaintenance(options: TaskControlPorts, journal: KanbanAutomationJournal, board: string, item: string, controlId: string): Promise<'cancelled' | 'accepted' | 'unknown'> {
    const jobs=(await Promise.all(['review-operation:','coordination-operation:'].map(prefix=>journal.findForBoard<ReviewJob>(prefix,board,job=>job.itemId===item&&job.phase!=='settled')))).flat();
    for (const row of jobs) {
        const saved = await journal.update<ReviewJob>(row.key, old => old!.phase === 'prepared' ? {...old!,phase:'settled',state:'failed',code:'USER_CANCELLED'} : old!);
        if (saved.phase === 'settled') continue;
        if (saved.action === 'accept') return 'accepted';
        requireValue(saved.request ?? saved.input, 'TASK_CONTROL_ROUTE_MISSING');
        const id = sha256HexSync(JSON.stringify([controlId,saved.id]));
        const state = await options.control.control({executionId:saved.sessionId??saved.id,operationId:id,action:'cancel',attemptId:saved.id,kind:saved.request?'submission':'call',prepared:saved.request??saved.input});
        if (state !== 'cancelled') return state === 'unknown' ? 'unknown' : 'accepted';
        await journal.update<ReviewJob>(row.key, old => old!.phase === 'settled' ? old! : {...old!,phase:'settled',state:'failed',code:'USER_CANCELLED'});
    }
    return cancelPostloads(options,journal,board,item,controlId);
}
interface Postload {boardId: string; dispatch: {itemId: string; id: string}; phase: string; done?: boolean; observation?: {outcome:string;code?:string}}
async function cancelPostloads(options: TaskControlPorts, journal: KanbanAutomationJournal, board: string, item: string, controlId: string): Promise<'cancelled' | 'accepted' | 'unknown'> {
    const rows = await journal.find<Postload>(options.finalizerPrefix ?? 'execution-finalizer:', job => job.boardId === board && job.dispatch.itemId === item && !job.done);
    for (const row of rows) {
        const job = await journal.update<Postload>(row.key, old => old!.phase === 'prepared' ? {...old!,phase:'settled',done:true,observation:{outcome:'cancelled',code:'USER_CANCELLED'}} : old!);
        if (job.done) continue;
        const state = await controlCall(options,journal,job.dispatch.id,sha256HexSync(JSON.stringify([controlId,job.dispatch.id])),'cancel');
        if (state !== 'cancelled') return state === 'unknown' ? 'unknown' : 'accepted';
        await journal.update<Postload>(row.key, old => ({...old!,phase:'settled',done:true,observation:{outcome:'cancelled',code:'USER_CANCELLED'}}));
    }
    return 'cancelled';
}
