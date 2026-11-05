import {runtimeLogger} from './logging';
import {defaultReferences} from './ports';
import {cancelTaskMaintenance} from './task-maintenance-cancellation';
import {cancelTaskReplies} from './task-reply-cancellation';

import type {KanbanBoard, KanbanItem, KanbanService, KanbanTaskControl} from '../contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import {journalCommand} from './journal-command';
import {controlTaskAnalyses} from './task-analysis-controls';
import type {KanbanTaskControlOptions as CallLifecyclePorts} from './control-ports';
import {controlExecution as controlCall} from './control';
import {requireValue} from '../rules';
export type TaskControlPorts = CallLifecyclePorts;

type Observation = Pick<KanbanTaskControl, 'state' | 'code'>;

/** Controls run even with scheduling disabled and never depend on the business channel. */
export async function scanTaskControls(options: TaskControlPorts, journal: KanbanAutomationJournal, board: KanbanBoard, service: KanbanService): Promise<void> {
    const log = runtimeLogger(journal);
    for (const item of board.items) {
        const control = item.control; if (!control || ['failed','paused','resumed','cancelled'].includes(control.state)) continue;
        const started = Date.now();
        let result: Observation;
        try {
            const state = await observe(options, journal, board, item, service);
            const latest = state === 'cancelled' ? await service.read(board.id) : board;
            const childrenPending = latest.items.some(child => child.planning?.parentId === item.id && !['completed','cancelled'].includes(child.status));
            result = {state: state === 'cancelled' && childrenPending ? 'accepted' : state};
        } catch (error) {result = controlFailure(error);}
        if (result.state === control.state && result.code === control.code) continue;
        const fields = {operation:'kanban.task.control', operationId:control.id, boardId:board.id, itemId:item.id, stage:control.action, result:['failed','unknown'].includes(result.state)?'failure' as const:'success' as const, code:result.code, state:result.state, durationMs:Date.now()-started};
        if (fields.result === 'failure') log.warn('Task control observed', fields); else log.info('Task control observed', fields);
        await journalCommand(journal, service, board.id, 'task-control-projection:' + JSON.stringify([board.id,item.id,control.id]) + ':' + result.state + ':' + (result.code ?? ''),
            {type: 'control-receipt', itemId: item.id, controlId: control.id, ...result});
    }
}
async function observe(options: TaskControlPorts, journal: KanbanAutomationJournal, board: KanbanBoard, item: KanbanItem, service: KanbanService): Promise<KanbanTaskControl['state']> {
    const control = item.control!;
    if (control.action === 'cancel') {
        const collaboration=await options.beforeCancel?.(board.id,item.id,control.id);if(collaboration&&collaboration!=='cancelled')return collaboration;
        const state = await cancelTaskReplies(options, journal, board.id, item.id, control.id);
        if (state !== 'cancelled') return state;
        const maintenance = await cancelTaskMaintenance(options,journal,board.id,item.id,control.id);
        if (maintenance !== 'cancelled') return maintenance;
    }
    const analysis = await controlTaskAnalyses(options,journal,board.id,item);
    if (analysis) return analysis;
    const workflow = await service.workflow(board.id);
    const dispatch = Object.values(workflow.dispatches).filter(d => d.itemId === item.id).sort((a,b) => b.attempt - a.attempt)[0];
    if (dispatch) {
        if (control.action === 'cancel' && ['failed','cancelled','rejected'].includes(dispatch.outcome)) return 'cancelled';
        return controlCall(options, journal, dispatch.continuation ? dispatch.executionSessionId ?? dispatch.id : dispatch.id, control.id, control.action, dispatch.id, 'task-control:' + board.id + ':' + control.id, !!dispatch.continuation);
    }
    requireValue((!item.owner || item.owner.kind === 'human') && !item.externalRefs?.some(ref => ref.system === (options.references ?? defaultReferences).execution), 'TASK_CONTROL_ROUTE_MISSING');
    return control.action === 'cancel' ? 'cancelled' : control.action === 'pause' ? 'paused' : 'resumed';
}
function controlFailure(error: unknown): Observation {
    const raw = (error as {code?: unknown})?.code, code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : 'TASK_CONTROL_UNKNOWN';
    return {state: ['TASK_CONTROL_UNSUPPORTED','CALL_READ_ONLY','CONTROL_EPOCH_CONFLICT'].includes(code) ? 'failed' : 'unknown', code};
}
