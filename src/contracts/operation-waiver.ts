import type {KanbanActor} from './contracts';
export interface KanbanOperationWaiver {
    id: string; dispatchId: string; action: string; reason: string; at: number; actor: KanbanActor;
    acceptanceWaived?: boolean;
    /** Frozen waiver propagation graph, independent of execution prerequisites. */
    dependencies: Record<string, string[]>;
    operations: Array<{id: string; cause: 'direct' | 'dependency'; previousState: string; previousRunId?: string}>;
}
export interface KanbanAcceptanceResult {
    dispatchId: string; outcome: 'passed' | 'waived'; at: number; actor: KanbanActor; waiverId?: string;
}
