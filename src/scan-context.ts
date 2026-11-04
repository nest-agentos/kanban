import type {KanbanBoard, KanbanItem, KanbanScanInput, KanbanScanText} from './contracts';
import type {KanbanDiscoveryOptions} from './scan-ports';
import type {KanbanState} from './ports';
import {requireValue} from './rules';

/** A bounded working set, with explicit omitted counts instead of pretending full coverage. */
export function scanContext(board: KanbanBoard, state: KanbanState, sessions: KanbanScanText[], options: KanbanDiscoveryOptions, runId: string): KanbanScanInput {
    requireValue(state.board.revision === board.revision, 'SCAN_BOARD_CHANGED');
    const archived = state.archiveIndex ?? [];
    const input: KanbanScanInput = {runId, executorId: options.executor.identity, board: {...board, items: []}, sessions,
        connection: structuredClone(options.policy.connection), projectContext: {totalRecords: state.records?.filter(record => record.status === 'confirmed').length ?? 0, omittedRecords: state.records?.filter(record => record.status === 'confirmed').length ?? 0, excludedRecords: state.records?.filter(record => record.status !== 'confirmed').length ?? 0, records: []}, context: {totalItems: board.items.length, omittedItems: board.items.length,
            archivedTotal: archived.length, archivedItems: []}};
    const bytes = () => new TextEncoder().encode(JSON.stringify(input)).length;
    requireValue(bytes() <= options.policy.maxInputBytes, 'SCAN_INPUT_LIMIT');
    const sessionIds = new Set(sessions.map(s => s.session.id));
    addRecords(input, state, sessionIds, bytes, options.policy.maxInputBytes);
    const content = sessions.flatMap(s => s.messages.map(m => m.text.toLowerCase())).join('\n');
    const ordered = [...board.items].sort((a, b) => score(a, sessionIds, content) - score(b, sessionIds, content)
        || (a.planning?.priority ?? 2) - (b.planning?.priority ?? 2) || a.id.localeCompare(b.id));
    for (const item of ordered) {
        if (input.board.items.length >= 50) break;
        input.board.items.push(item); input.context!.omittedItems--;
        if (bytes() > options.policy.maxInputBytes) {input.board.items.pop(); input.context!.omittedItems++;}
    }
    const history = [...archived].sort((a, b) => Number(b.sessionIds.some(id => sessionIds.has(id))) - Number(a.sessionIds.some(id => sessionIds.has(id)))
        || (b.closedAt ?? b.updatedAt) - (a.closedAt ?? a.updatedAt));
    for (const item of history.slice(0, 20)) {
        input.context!.archivedItems.push(item);
        if (bytes() > options.policy.maxInputBytes) input.context!.archivedItems.pop();
    }
    return structuredClone(input);
}
function addRecords(input: KanbanScanInput, state: KanbanState, sessionIds: Set<string>, bytes: () => number, maxBytes: number): void {
    const records = (state.records ?? []).filter(record => record.status === 'confirmed').sort((a, b) => Number(b.kind === 'decision') - Number(a.kind === 'decision')
        || Number(b.sources.some(source => sessionIds.has(source.sessionId))) - Number(a.sources.some(source => sessionIds.has(source.sessionId))) || b.createdAt - a.createdAt);
    for (const record of records.slice(0, 10)) {
        input.projectContext!.records.push(record); input.projectContext!.omittedRecords--;
        if (bytes() > maxBytes) {input.projectContext!.records.pop(); input.projectContext!.omittedRecords++;}
    }
}

function score(item: KanbanItem, sessions: Set<string>, content: string): number {
    if (item.sources?.some(source => sessions.has(source.sessionId)) || content.includes(item.title.toLowerCase())) return 0;
    if (item.status === 'claimed' || item.status === 'review') return 1;
    if (item.status === 'open') return 2;
    return item.status === 'completed' || item.status === 'cancelled' ? 4 : 3;
}
