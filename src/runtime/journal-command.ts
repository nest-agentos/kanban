import {randomUUID} from '../utils';
import {KanbanError} from '../ports';
import type {KanbanCommand, KanbanRequest, KanbanService} from '../contracts';
import type {KanbanAutomationJournal} from './automation-journal';

interface Entry {request: KanbanRequest; done?: boolean}

/** Unknown responses retain the frozen request; only a definite CAS rejection can rebase. */
export async function journalCommand(journal: KanbanAutomationJournal, service: Pick<KanbanService, 'read' | 'execute'>,
    boardId: string, key: string, command: KanbanCommand): Promise<void> {
    if ((await journal.get<Entry>(key))?.done) return;
    const board = await service.read(boardId);
    const entry = await journal.update<Entry>(key, old => old ?? {request: {operationId: randomUUID(), expectedRevision: board.revision, command}});
    if (entry.done) return;
    try {await service.execute(boardId, entry.request);}
    catch (error) {
        if (error instanceof KanbanError && error.code === 'REVISION_CONFLICT') {
            const latest = await service.read(boardId);
            await journal.update<Entry>(key, old => old?.request.operationId !== entry.request.operationId || old.done ? old! : {
                request: {...entry.request, operationId: randomUUID(), expectedRevision: latest.revision}});
        }
        throw error;
    }
    await journal.update<Entry>(key, old => ({...old!, done: true}));
}
