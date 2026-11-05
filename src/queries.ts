import {projectKanbanTask} from './contracts/task-projection';
import {kanbanReference} from './contracts';
import type {KanbanItemPage, KanbanItemQuery, KanbanItemSummary, KanbanOverview} from './contracts';
import type {KanbanState} from './ports';
import {requireValue} from './rules';
import {executable} from './configuration';
import {catalog, limits, summary, terminal} from './planning';

export function queryItems(state: KanbanState, query: KanbanItemQuery = {}, all = catalog(state), now = Date.now()): KanbanItemPage {
    const {cursor, limit = 50, ...filters} = query;
    requireValue(Number.isSafeInteger(limit) && limit >= 1 && limit <= 200, 'INVALID_PAGE_SIZE');
    requireValue(['ready', 'backlog', 'in-progress', 'review', 'closed', 'proposed', 'archive', 'all'].includes(query.view ?? 'ready'), 'INVALID_VIEW');
    for (const field of ['area', 'milestone', 'parentId', 'kind', 'sessionId', 'search', 'restartedFrom'] as const) if (filters[field] !== undefined) requireValue(typeof filters[field] === 'string' && filters[field]!.length <= 256, 'INVALID_FILTER');
    if (filters.reference) requireValue(typeof filters.reference.system === 'string' && typeof filters.reference.id === 'string' && filters.reference.system.length <= 256 && filters.reference.id.length <= 256, 'INVALID_REFERENCE_FILTER');
    const fingerprint = JSON.stringify(Object.fromEntries(Object.entries({...filters, view: filters.view ?? 'ready'}).sort(([a], [b]) => a.localeCompare(b)))), revision = state.board.revision;
    all = all.map(item => ({...item, task: projectKanbanTask(item, state.workflow, now, all)}));
    const matches = all.filter(item => matchesQuery(item, filters, state.board)).sort(filters.view === 'archive'
        ? (a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0) || a.id.localeCompare(b.id) : order);
    let start = 0;
    if (cursor) {
        requireValue(typeof cursor === 'string' && cursor.length <= 4000, 'INVALID_CURSOR');
        let decoded: {revision: number; after: string; filter: string};
        try {decoded = JSON.parse(cursor);} catch {requireValue(false, 'INVALID_CURSOR');}
        requireValue(decoded && decoded.filter === fingerprint, 'CURSOR_SCOPE_MISMATCH');
        requireValue(decoded.revision === revision, 'CURSOR_STALE');
        start = matches.findIndex(i => i.id === decoded.after) + 1; requireValue(start > 0, 'INVALID_CURSOR');
    }
    const progress = progressByParent(state, all);
    const items = matches.slice(start, start + limit).map(item => ({...item, ...(progress.has(item.id) ? {progress: progress.get(item.id)} : {})}));
    return {revision,total:matches.length,items,...(query.parentId?{progress:childProgress(matches),parentTask:all.find(item=>item.id===query.parentId)?.task}:{}), ...(start + items.length < matches.length ? {
        nextCursor: JSON.stringify({revision, after: items.at(-1)!.id, filter: fingerprint}),
    } : {})};
}
function order(a: KanbanItemSummary, b: KanbanItemSummary): number {
    return a.planning.priority - b.planning.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}
function matchesQuery(item: KanbanItemSummary, query: Omit<KanbanItemQuery, 'cursor' | 'limit'>, board: KanbanState['board']): boolean {
    if(query.excludePlanning&&item.purpose==='planning')return false;
    if(query.excludeArchived&&item.archivedAt!==undefined)return false;
    if (item.deletedAt !== undefined && !query.includeDeleted) return false;
    if (query.restartedFrom !== undefined && item.restartedFrom !== query.restartedFrom) return false;
    if (query.phase && item.task?.phase !== query.phase) return false;
    if (!matchesView(item, query.view ?? 'ready')) return false;
    for (const field of ['area', 'milestone', 'parentId', 'kind'] as const) if (query[field] !== undefined && item.planning[field] !== query[field]) return false;
    if (query.reference && !item.externalRefs?.some(r => r.system === query.reference!.system && r.id === query.reference!.id)) return false;
    if (query.sessionId && !item.sessionIds.includes(query.sessionId)) return false;
    if (query.search && !`${kanbanReference(board, item)} ${item.id} ${item.title} ${item.planning.area ?? ''}`.toLowerCase().includes(query.search.toLowerCase())) return false;
    return true;
}
function matchesView(item: KanbanItemSummary, view: KanbanItemQuery['view']): boolean {
    if (view === 'archive') return item.archivedAt !== undefined;
    if (view === 'all') return true;
    if (item.archivedAt !== undefined) return false;
    if (view === 'in-progress') return item.status === 'claimed' || item.status === 'review';
    if (view === 'closed') return terminal(item);
    return item.status === ({ready: 'open', backlog: 'backlog', review: 'review', proposed: 'proposed'} as Record<string, string>)[view!];
}
export function overview(state: KanbanState, now: number, items = state.board.items.map(summary)): KanbanOverview {
    items=items.filter(item=>item.deletedAt===undefined&&item.purpose!=='planning');
    const count = (status: string) => items.filter(i => i.status === status).length;
    const age = state.board.policy.backlogReviewMs;
    return {revision: state.board.revision, visible: items.length, active: items.filter(i => !terminal(i)).length, archived: state.archiveIndex?.length ?? 0, ready: count('open'),
        inProgress: count('claimed') + count('review'), backlog: count('backlog'), proposed: count('proposed'),
        closed: count('completed') + count('cancelled'), dueForReview: age ? items.filter(i => i.status === 'backlog' && now - i.updatedAt >= age).length : 0,
        limits: limits(state)};
}

function progressByParent(state: KanbanState, all: KanbanItemSummary[]): Map<string, NonNullable<KanbanItemSummary['progress']>> {
    const byId = new Map(all.map(i => [i.id, i]));
    const result = new Map<string, NonNullable<KanbanItemSummary['progress']>>();
    for (const item of all.filter(i => executable(state.board, i))) {
        let parent = item.planning.parentId; const seen = new Set<string>();
        while (parent && !seen.has(parent)) {
            seen.add(parent); const progress = result.get(parent) ?? {total: 0, completed: 0, cancelled: 0, inProgress: 0};
            progress.total++; if (item.status === 'completed') progress.completed++; if (item.status === 'cancelled') progress.cancelled++;
            if (item.status === 'claimed' || item.status === 'review') progress.inProgress++;
            result.set(parent, progress); parent = byId.get(parent)?.planning.parentId;
        }
    }
    return result;
}

function childProgress(items:KanbanItemSummary[]):import('./contracts/planning').KanbanProgress {
    const count=(phases:string[])=>items.filter(item=>phases.includes(item.task?.phase??'')).length;
    return {total:items.length,completed:count(['completed']),cancelled:count(['cancelled']),inProgress:count(['running','preparing','analyzing','queued','resuming']),
        waitingInput:count(['waiting-input']),errors:count(['error','unknown']),review:count(['review']),paused:count(['paused','pausing']),waiting:count(['waiting-start','waiting-dependency'])};
}
