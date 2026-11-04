import type {KanbanItemSummary} from './planning';
import type {KanbanBoard} from './contracts';

export type {KanbanSourceRef, KanbanDiscoveryChange, KanbanDiscoveryBatch} from './source';
import type {KanbanDiscoveryChange} from './source';
export interface KanbanScanSession {
    id: string; revision: string; updatedAt: number | null; idleSince: number | null;
    activity: 'idle' | 'active' | 'waiting' | 'unknown'; archived: boolean; scannerOwned?: boolean;
}
export interface KanbanScanText {
    session: KanbanScanSession; complete: boolean;
    messages: Array<{id: string; role: 'user' | 'assistant'; text: string}>;
}
export interface KanbanScanConnection {
    kind: 'local' | 'remote'; connectionId: string;
    /** Explicit consent for moving source text to a different execution boundary. */
    allowContentTransfer: boolean;
}
export interface KanbanScanPolicy {
    idleMs: number; includeArchived: boolean; maxSessions: number; maxInputBytes: number; leaseMs: number;
    autoCreate: boolean; connection: KanbanScanConnection;
}
export interface KanbanScanInput {
    projectContext?: {totalRecords: number; excludedRecords?: number; omittedRecords: number; records: import('./context').KanbanProjectRecord[]};
    context?: {totalItems: number; omittedItems: number; archivedTotal: number; archivedItems: KanbanItemSummary[]};
    runId: string; executorId: string; board: KanbanBoard; sessions: KanbanScanText[]; connection: KanbanScanConnection;
}
export const DEFAULT_KANBAN_SCAN_POLICY: Omit<KanbanScanPolicy, 'connection'> = {
    idleMs: 300000, includeArchived: true, maxSessions: 20, maxInputBytes: 128 * 1024, leaseMs: 600000, autoCreate: false,
};

export interface KanbanDiscoveryResult {changes: KanbanDiscoveryChange[]; records?: import('./context').KanbanRecordInput[]}
