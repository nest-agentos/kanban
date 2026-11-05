import {sha256HexSync} from '../utils';
import type {KanbanBoard, KanbanEvent, KanbanItemSummary, KanbanProjectRecord, KanbanRecordActivity, KanbanExternalReference} from '../contracts';
import {defaultReferences, type KanbanWorkLogOptions} from './ports';


export function createWorkLogProjection(options: KanbanWorkLogOptions = {}) {
const references = options.references ?? defaultReferences;
function eventActivity(event: KanbanEvent): KanbanRecordActivity | undefined {
    const base = {actor: {kind: event.actor.kind ?? 'agent' as const, id: event.actor.id ?? event.actor.agentId ?? 'unknown'}, result: 'success' as const, ...(event.data.dispatchId ? {dispatchId: event.data.dispatchId} : {})};
    if (event.kind === 'report-analysis') return {...base, stage:'analysis.'+(event.data.reason?.slice('analysis-'.length) ?? 'unknown'), result:event.data.code?'failure':'success', code:event.data.code};
    if (event.kind === 'control-receipt') return {...base, stage:'execution.'+(event.data.reason ?? 'control-unknown'), result:event.data.code?'failure':'success', code:event.data.code};
    if (event.kind === 'restart-item') return {...base, stage:'task.restarted'};
    if (event.kind === 'create-item') return {...base, stage: 'task.created'};
    if (event.kind === 'prepare-dispatch') return {...base, stage: 'execution.prepared'};
    if (event.kind === 'continue-execution') return {...base, stage: 'execution.continued'};
    if (event.kind === 'submit') return {...base, stage: 'execution.review'};
    if (event.kind === 'close-plan' || event.kind === 'review' && event.data.reason === 'accepted' || event.kind === 'accept-execution' && event.data.reason === 'accepted') return {...base, stage: 'task.completed'};
    if (event.kind === 'cancel-item' || event.kind === 'release-item' && event.data.reason === 'cancelled') return {...base, stage: 'task.cancelled', result: 'cancelled'};
    if (event.kind === 'observe-execution') {
        const result = event.data.reason?.slice('execution-'.length);
        if (result && ['running', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(result)) return {...base,
            stage: result === 'succeeded' && event.data.status === 'completed' ? 'task.completed' : 'execution.' + result, result: result === 'failed' || result === 'unknown' ? 'failure' : result === 'cancelled' ? 'cancelled' : 'success', code: event.data.code};
    }
    if (event.kind === 'link-reference' && event.data.reference) {
        const system = event.data.reference.system;
        const stage = system === references.execution ? 'session.bound' : system === references.nativeExecution ? 'session.native' : system === references.workspace ? 'worktree.prepared' : undefined;
        if (stage) return {...base, stage};
    }
    if (event.kind === 'message') return {...base, stage: 'task.message'};
    if (event.kind === 'block-item') return {...base, stage: 'task.blocked', result: 'failure', code: event.data.reason};
    return undefined;
}
function activityRecord(board: Pick<KanbanBoard, 'id'>, item: KanbanItemSummary | undefined, id: string, at: number,
    activity: KanbanRecordActivity, refs: KanbanExternalReference[] = [], content?: string, ancestors: string[] = []): KanbanProjectRecord {
    const label = options.label?.(activity.stage) ?? activity.stage;
    return {id: 'activity-' + sha256HexSync(JSON.stringify([board.id, id])), kind: 'log', title: [item?.title, label].filter(Boolean).join(' · '),
        content: content ?? [label, activity.code, ...Object.entries(activity.fields ?? {}).map(([key, value]) => `${key}: ${value}`)].filter(Boolean).join('\n'),
        activity, externalRefs: refs, itemIds: [...new Set([...(item ? [item.id] : []), ...ancestors])], sources: [],
        author: activity.actor ?? {kind: 'service', id: 'kanban-activity'}, origin: 'flow', status: 'confirmed', revision: 1, createdAt: at, updatedAt: at};
}
function ancestorIds(item: KanbanItemSummary | undefined, items: KanbanItemSummary[]): string[] {
    const result: string[] = [], seen = new Set(item ? [item.id] : []); let parent = item?.planning.parentId;
    while (parent && !seen.has(parent)) {seen.add(parent); result.push(parent); parent = items.find(row => row.id === parent)?.planning.parentId;}
    return result;
}

function lifecycleReferences(refs: KanbanExternalReference[] = []): KanbanExternalReference[] {
    return [references.execution, references.nativeExecution, references.workspace].flatMap(system => {
        const ref = refs.filter(ref => ref.system === system).at(-1); return ref ? [ref] : [];
    });
}

return {eventActivity,activityRecord,ancestorIds,lifecycleReferences};
}
