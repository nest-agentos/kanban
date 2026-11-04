import type {KanbanActor, KanbanBoardInput} from './contracts';
import type {KanbanState} from './ports';
import {policy} from './configuration';
import {participant, validateBoard} from './rules';

export function createBoardState(input: KanbanBoardInput, actor: KanbanActor, now: number): KanbanState {
    const board = {...structuredClone(input), policy: policy(input.policy), revision: 1, items: [], participants: []};
    validateBoard(board);
    if (actor.sessionId) participant(board.participants, actor.sessionId, actor.agentId, 'creator', true, now);
    for (const session of board.policy.escalationSessionIds) participant(board.participants, session, undefined, 'escalation', true, now);
    return {schema: 1, board, sequence: 0, events: [], escalations: []};
}
