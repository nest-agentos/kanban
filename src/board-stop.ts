import type {KanbanActor, KanbanCommand} from './contracts';
import type {KanbanState} from './ports';
import {requireValue, identity} from './rules';
import {requireCoordinator} from './workflow-plans';
import {applyTaskCommand} from './task-commands';
import {sha256HexSync} from './utils';
type StopCommand = Extract<KanbanCommand, {type:'request-board-stop' | 'observe-board-stop'}>;
export function stopBoard(state: KanbanState, command: StopCommand, actor: KanbanActor, now: number): void {
    requireCoordinator(state,actor); requireValue(actor.kind === 'human','FORBIDDEN'); identity(command.controlId);
    if (command.type === 'observe-board-stop') {
        requireValue(state.board.lifecycle?.operationId === command.controlId,'STALE_CONTROL_RECEIPT');
        requireValue(['waiting','ready','blocked'].includes(command.phase),'INVALID_CONTROL_STATE');
        requireValue(command.code === undefined || /^[A-Z][A-Z0-9_]{0,79}$/.test(command.code),'INVALID_ERROR_CODE');
        state.board.lifecycle!.phase = command.phase; state.board.lifecycle!.code = command.code; return;
    }
    requireValue(['cancel','delete'].includes(command.intent) && ['drain','cancel'].includes(command.mode),'INVALID_BOARD_CONTROL');
    const old = state.board.lifecycle;
    if (old) {requireValue(old.intent === 'cancel' && command.intent === 'delete' || old.operationId === command.controlId,'BOARD_STOP_PENDING'); if (old.operationId === command.controlId) return;}
    state.board.lifecycle = {operationId:command.controlId,intent:command.intent,mode:command.mode,phase:'waiting'};
    state.board.executionControl = {...state.board.executionControl,mode:'manual',paused:true,controls:{}};
    if (state.board.automation) state.board.automation.enabled = false;
    if (command.mode !== 'cancel') return;
    for (const item of state.board.items) if (!['completed','cancelled'].includes(item.status)) applyTaskCommand(state,
        {type:'request-control',itemId:item.id,controlId:sha256HexSync(JSON.stringify([command.controlId,item.id])),action:'cancel'},actor,now);
}
export function protectStoppedBoard(state: KanbanState, command: KanbanCommand): void {
    if (!state.board.lifecycle) return;
    if (command.type === 'append-record' && command.record.kind === 'decision') requireValue(false,'BOARD_STOPPING');
    const fresh = ['restart-item','reopen-item','create-item','admit-item','prepare-dispatch','continue-execution','publish-plan','request-run','apply-discovery','begin-edit','save-edit'];
    requireValue(!fresh.includes(command.type),'BOARD_STOPPING');
    if (command.type === 'set-board-control') requireValue(command.paused !== false && command.mode !== 'automatic','BOARD_STOPPING');
    if (command.type === 'configure-automation') requireValue(!command.settings.enabled,'BOARD_STOPPING');
}
