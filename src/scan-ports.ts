import type {KanbanDiscoveryChange, KanbanRequest, KanbanScanInput, KanbanScanPolicy, KanbanScanSession, KanbanScanText, KanbanService} from './contracts';
import type {KanbanModuleOptions, KanbanStore} from './ports';

export interface KanbanDiscoveryState {
    checkpoints: Record<string, string>;
    observations?: Record<string, {revision: string; idleSince: number}>;
    lastRun?: {runId: string; outcome: 'committed' | 'invalidated'; at: number; code?: string};
    pending?: {runId: string; autoCreate: boolean; token: string; leaseUntil: number; input: KanbanScanInput;
        executionStarted?: boolean; executionSettled?: boolean; changes?: KanbanDiscoveryChange[]; records?: import('./contracts').KanbanRecordInput[]; request?: KanbanRequest};
}
export interface KanbanScanSource {
    scope?: import('./contracts').KanbanBoard['scope'];
    projectId?: string; kind: 'local' | 'remote';
    /** Must enumerate board-scoped sources, including archived sessions when requested. */
    list(includeArchived: boolean): Promise<KanbanScanSession[]>;
    inspect(sessionId: string): Promise<KanbanScanSession>;
    read(session: KanbanScanSession, maxBytes: number): Promise<KanbanScanText>;
}
export interface KanbanScanExecutor {
    readonly identity: string;
    /** Stable runId must reconnect to the existing analysis operation after response loss. */
    run(input: KanbanScanInput): Promise<KanbanDiscoveryChange[] | import('./contracts').KanbanDiscoveryResult>;
    settled?(input: KanbanScanInput): Promise<boolean>;
}
export interface KanbanDiscoveryOptions {
    boardId: string; store: KanbanStore; service: KanbanService; source: KanbanScanSource;
    executor: KanbanScanExecutor; policy: KanbanScanPolicy;
    /** Revalidate project scope, source access, and chosen connection before reading/executing/committing. */
    authorize(stage: 'read' | 'execute' | 'commit', input?: KanbanScanInput): Promise<void>;
    now?: () => number; id?: () => string; log: KanbanModuleOptions['log'];
}
