import type {KanbanItem, KanbanExternalReference, KanbanWorkflowState, KanbanSessionAssociation, KanbanRelatedSession, KanbanSessionExecution, KanbanExecutionSession} from './contracts';

export function sessionAssociations(item: KanbanItem, bindings: KanbanExternalReference[], workflow: KanbanWorkflowState): KanbanSessionAssociation[] {
    return [...bindings.map(ref => {
        const dispatch = workflow.dispatches[ref.revision ?? ''];
        const execution: KanbanSessionExecution | undefined = dispatch?.itemId === item.id ? {
            id: dispatch.id, purpose: 'execution', dispatchId: dispatch.id, attempt: dispatch.attempt,
            outcome: dispatch.outcome, createdAt: dispatch.preparedAt, code: dispatch.code,
            ...(dispatch.continuation ? {previousDispatchId: dispatch.continuation.previousDispatchId} : {}),
        } : undefined;
        return {sessionId: ref.id, purpose: 'execution' as const, ...(execution ? {execution} : {})};
    }), ...item.participants.filter(row => !bindings.some(ref => ref.id === row.sessionId)).map(row => ({sessionId: row.sessionId, purpose: 'discussion' as const}))];
}

/** Session identity and run identity are independent; neither activity nor a hook selects the primary. */
export async function projectRelatedSessions(associations: KanbanSessionAssociation[], currentId: string | undefined,
    inspect: (id: string) => Promise<KanbanExecutionSession>): Promise<KanbanRelatedSession[]> {
    const grouped = new Map<string, {purposes: Set<KanbanSessionAssociation['purpose']>; executions: Map<string, KanbanSessionExecution>}>();
    for (const row of associations) {
        let group = grouped.get(row.sessionId);
        if (!group) grouped.set(row.sessionId, group = {purposes: new Set(), executions: new Map()});
        group.purposes.add(row.purpose);
        if (row.execution) group.executions.set(row.execution.id, {...group.executions.get(row.execution.id), ...row.execution});
    }
    const rows: KanbanRelatedSession[] = [], entries = [...grouped]; let next = 0;
    await Promise.all(Array.from({length: Math.min(entries.length, 8)}, async () => {
        while (next < entries.length) {
            const [sessionId, group] = entries[next++], state = await inspect(sessionId);
            rows.push({...state, current: sessionId === currentId, purposes: [...group.purposes].sort(),
                executions: [...group.executions.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id))});
        }
    }));
    return rows.sort((a, b) => Number(b.current) - Number(a.current) || a.sessionId.localeCompare(b.sessionId));
}
