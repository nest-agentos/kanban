import type {KanbanEvent} from '../contracts';

/** Old persisted heartbeat events remain available to audit readers, without cluttering task history. */
export function meaningfulItemEvents(events: KanbanEvent[]): KanbanEvent[] {
    const last = new Map<string, string>(), hidden = new Set<KanbanEvent>();
    for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
        if (event.kind === 'renew') {hidden.add(event); continue;}
        if (event.kind !== 'observe-execution' || !event.data.dispatchId || !event.data.reason) continue;
        const key = JSON.stringify([event.boardId, event.itemId, event.data.dispatchId]);
        const state = JSON.stringify([event.data.reason, event.data.code, event.data.status]);
        if (last.get(key) === state) hidden.add(event);
        last.set(key, state);
    }
    return events.filter(event => !hidden.has(event));
}
