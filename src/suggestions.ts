import {kanbanReference} from './contracts';
import type {KanbanSuggestion, KanbanSuggestionPage, KanbanSuggestionQuery} from './contracts';
import type {KanbanState} from './ports';
import {recordSummary} from './project-records';
import {catalog, terminal} from './planning';
import {workType} from './configuration';
import {identity, requireValue} from './rules';

export function validateSuggestionQuery(query: KanbanSuggestionQuery): number {
    requireValue(query && ['item', 'parent', 'dependency', 'area', 'milestone', 'decision', 'session'].includes(query.kind), 'INVALID_SUGGESTION_KIND');
    requireValue(query.search === undefined || typeof query.search === 'string' && query.search.length <= 256, 'INVALID_FILTER');
    const limit = query.limit ?? 20; requireValue(Number.isSafeInteger(limit) && limit > 0 && limit <= 50, 'INVALID_LIMIT');
    if (query.excludeItemId !== undefined) identity(query.excludeItemId);
    if (query.excludeIds !== undefined) {requireValue(Array.isArray(query.excludeIds) && query.excludeIds.length <= 100, 'INVALID_FILTER'); query.excludeIds.forEach(identity);}
    if (query.childKind !== undefined) identity(query.childKind);
    return limit;
}
export function suggestionPage(revision: number, rows: KanbanSuggestion[], query: KanbanSuggestionQuery): KanbanSuggestionPage {
    const limit = validateSuggestionQuery(query), search = query.search?.trim().toLocaleLowerCase() ?? '';
    const matched = rows.filter(row => !query.excludeIds?.includes(row.id)).filter(row => `${row.id} ${row.label} ${row.detail ?? ''}`.toLocaleLowerCase().includes(search))
        .sort((a, b) => score(a.label, search) - score(b.label, search) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    return {revision, items: matched.slice(0, limit).map(row => ({id: row.id, label: row.label.slice(0, 256), ...(row.detail ? {detail: row.detail.slice(0, 512)} : {}), ...(row.status ? {status: row.status} : {}), ...(row.archived !== undefined ? {archived: row.archived} : {})})), hasMore: matched.length > limit};
}
const score = (label: string, query: string) => label.toLocaleLowerCase() === query ? 0 : label.toLocaleLowerCase().startsWith(query) ? 1 : 2;
export function suggestFromState(state: KanbanState, query: KanbanSuggestionQuery, items = catalog(state), records = (state.records ?? []).map(recordSummary)): KanbanSuggestionPage {
    validateSuggestionQuery(query);
    if (query.kind === 'area' || query.kind === 'milestone') {
        const names = [...new Set(items.map(item => item.planning[query.kind as 'area' | 'milestone']).filter((name): name is string => !!name))];
        return suggestionPage(state.board.revision, names.map(name => ({id: name, label: name})), query);
    }
    if (query.kind === 'decision') return suggestionPage(state.board.revision, records
        .filter(record => record.kind === 'decision' && record.status === 'confirmed').map(record => ({id: record.id, label: record.title, detail: kanbanReference(state.board, record)})), query);
    if (query.kind === 'session') {
        const ids = new Set([...state.board.participants.map(p => p.sessionId), ...items.flatMap(item => item.sessionIds),
            ...records.flatMap(record => record.sessionIds)]);
        return suggestionPage(state.board.revision, [...ids].map(id => ({id, label: id})), query);
    }
    const blocked = query.kind === 'dependency' && query.excludeItemId ? dependents(items, query.excludeItemId) : new Set<string>();
    const rank = query.kind === 'parent' ? workType(state.board, query.childKind ?? state.board.defaultWorkType ?? 'task').rank : undefined;
    const rows = items.filter(item => item.id !== query.excludeItemId && !blocked.has(item.id)
        && (query.kind !== 'dependency' || item.status !== 'cancelled')
        && (rank === undefined || item.archivedAt === undefined && !terminal(item) && workType(state.board, item.planning.kind).rank < rank))
        .map(item => ({id: item.id, label: item.title, status: item.status, archived: item.archivedAt !== undefined,
            detail: [kanbanReference(state.board, item), item.planning.area, item.planning.milestone].filter(Boolean).join(' · ')}));
    return suggestionPage(state.board.revision, rows, query);
}
function dependents(items: import('./contracts').KanbanItemSummary[], id: string): Set<string> {
    const reverse = new Map<string, string[]>();
    for (const item of items) for (const dependency of item.planning.dependencies) reverse.set(dependency, [...(reverse.get(dependency) ?? []), item.id]);
    const result = new Set([id]), pending = [id];
    while (pending.length) for (const next of reverse.get(pending.pop()!) ?? []) if (!result.has(next)) {result.add(next); pending.push(next);}
    return result;
}
