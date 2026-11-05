import type {KanbanActor, KanbanCommand} from './contracts';
import type {KanbanState} from './ports';
import {requireValue} from './rules';
import {applyTaskCommand} from './task-commands';

type Command = Extract<KanbanCommand, {type: 'set-board-control'}>;
/** The scheduling barrier and original execution control requests commit together. */
export function setBoardControl(state: KanbanState, command: Command, actor: KanbanActor, now: number, token: string): void {
    requireValue(actor.kind === 'human', 'FORBIDDEN');
    requireValue(command.mode !== undefined || command.paused !== undefined, 'INVALID_BOARD_CONTROL');
    requireValue(command.mode === undefined || ['automatic', 'manual'].includes(command.mode), 'INVALID_LAUNCH_MODE');
    requireValue(command.paused === undefined || typeof command.paused === 'boolean', 'INVALID_BOARD_CONTROL');
    const policy = state.board.executionControl ??= {mode: 'automatic', paused: false, controls: {}};
    if (command.mode) policy.mode = command.mode;
    if (command.paused === undefined || command.paused === policy.paused) return;
    if (!command.paused) requireValue(!state.board.items.some(item => policy.controls[item.id] === item.control?.id && ['requested', 'unknown'].includes(item.control!.state)), 'CONTROL_UNSETTLED');
    policy.paused = command.paused;
    if (policy.paused) policy.controls = {};
    state.board.items.forEach((item, index) => {
        if (['completed', 'cancelled', 'review'].includes(item.status)) return;
        const active = item.analysis?.state === 'analyzing' || item.launch?.admittedAt !== undefined || Object.values(state.workflow?.dispatches ?? {}).some(d => d.itemId === item.id && ['prepared', 'running', 'unknown'].includes(d.outcome));
        const managed = policy.controls[item.id] === item.control?.id;
        if (policy.paused ? !active || item.control?.action === 'pause' : !managed || item.control?.action !== 'pause') return;
        if (item.control && ['requested', 'unknown'].includes(item.control.state)) return;
        const controlId = token + '-' + index;
        applyTaskCommand(state, {type: 'request-control', itemId: item.id, controlId, action: policy.paused ? 'pause' : 'resume'}, actor, now);
        policy.controls[item.id] = controlId;
    });
}
