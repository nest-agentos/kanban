import {expect, it} from 'vitest';
import type {KanbanEvent} from '../src/contracts';
import {meaningfulItemEvents} from '../src/ui/event-history';

it('hides historical renewals while retaining transitions, recovery, changed errors and independent attempts', () => {
    const event = (sequence: number, reason: string, code?: string, dispatchId = 'attempt'): KanbanEvent => ({
        sequence, boardId: 'board', itemId: 'task', operationId: 'op-' + sequence, at: sequence,
        kind: 'observe-execution', actor: {kind: 'service', id: 'worker'}, recipients: [], data: {dispatchId, reason, code},
    });
    const input = [event(1, 'execution-running'), event(2, 'execution-running'),
        {...event(3, ''), kind: 'message', data: {message: 'New progress'}}, event(4, 'execution-unknown', 'OFFLINE'),
        event(5, 'execution-unknown', 'OFFLINE'), event(6, 'execution-unknown', 'CHANGED'), event(7, 'execution-running'),
        event(8, 'execution-running', undefined, 'new-attempt'), {...event(9, ''), kind: 'renew'}].reverse();
    expect(meaningfulItemEvents(input).map(row => row.sequence)).toEqual([8, 7, 6, 4, 3, 1]);
    expect(input).toHaveLength(9);
});
