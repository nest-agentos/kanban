import type {ISeqFileTransaction} from '@nestos/vfs-core';
import {randomUUID} from '../utils';
import type {KanbanRuntimeDiagnostic} from './ports';
import {safeCode} from './diagnostics';

export const boardIndexPath = '/kanban/runtime/automation-board-index.seq';
const families = ['review-operation:', 'record-runs:', 'fix:', 'task-reply:'];
export function boardIndexPrefix(boardId: string, family: string): string {return JSON.stringify([boardId, family]).slice(0, -1) + ',';}
export function boardIndexKeys(key: string, value: unknown): string[] {
    const family = families.find(prefix => key.startsWith(prefix));
    if (!family) return [];
    const boards = new Set<string>();
    for (const row of Array.isArray(value) ? value : [value]) {
        if (!row || typeof row !== 'object') continue;
        for (const id of [row.boardId, row.sourceBoardId]) if (typeof id === 'string' && id) boards.add(id);
    }
    return [...boards].sort().map(board => JSON.stringify([board, family, key]));
}
/** Secondary references are committed atomically with their single source record. */
export async function updateBoardIndex(tx: ISeqFileTransaction, key: string, previous: string[], value: unknown, indexPath = boardIndexPath): Promise<void> {
    const next = new Set(boardIndexKeys(key, value)), oldKeys = new Set(previous);
    for (const old of previous) if (!next.has(old)) await tx.deleteEntry(indexPath, old);
    for (const index of next) if (!oldKeys.has(index)) await tx.setEntry(indexPath, index, key);
}
export async function migrateBoardIndex(tx: ISeqFileTransaction, source: string, indexPath = boardIndexPath, diagnostic: (event: KanbanRuntimeDiagnostic) => void = () => {}): Promise<void> {
    if (await tx.getEntry(indexPath, 'version') === '1') return;
    const started = Date.now(), operationId = randomUUID(); let count = 0;
    try {
        for (const keyPrefix of families) await tx.walkEntries(source, async entry => {
            await updateBoardIndex(tx, entry.key, [], JSON.parse(entry.value), indexPath); count++; return true;
        }, {keyPrefix});
        await tx.setEntry(indexPath, 'version', '1');
        diagnostic({operation: 'kanban.board.index', operationId, stage: 'migrate', result: 'success', count, durationMs: Date.now() - started});
    } catch (error) {
        diagnostic({operation: 'kanban.board.index', operationId, stage: 'migrate', result: 'failure', code: safeCode(error, 'BOARD_INDEX_MIGRATION_FAILED'), durationMs: Date.now() - started}); throw error;
    }
}
