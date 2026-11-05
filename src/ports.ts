import type { KanbanActor, KanbanBoard, KanbanCommand, KanbanEvent, KanbanArchivedItem, KanbanItemSummary } from './contracts';

export interface KanbanState {
    workflow?: import('./contracts').KanbanWorkflowState;
    numbering?: {item: number; log: number; decision: number};
    presetVersions?: Record<string, number>;
    records?: import('./contracts').KanbanProjectRecord[];
    discovery?: import('./scan-ports').KanbanDiscoveryState;
    archiveIndex?: KanbanItemSummary[];
    archiveWrites?: Array<{id: string; value: KanbanArchivedItem | null}>;
    restore?: KanbanArchivedItem;
    schema: 1; board: KanbanBoard; sequence: number; events: KanbanEvent[]; escalations: string[];
}
export interface KanbanReadView {
    /** Board metadata and summary indexes; no item/record bodies. */
    state: KanbanState;
    items: import('./contracts').KanbanItemSummary[];
    records: import('./contracts').KanbanRecordSummary[];
}
export interface KanbanStore {
    boardId?(number: number): Promise<string | null>;
    view?(id: string): Promise<KanbanReadView | null>;
    ids(): Promise<string[]>;
    archived(boardId: string, itemId: string): Promise<KanbanArchivedItem | null>;
    events(id: string, after: number, limit: number, through: number): Promise<KanbanEvent[]>;
    read(id: string): Promise<KanbanState | null>;
    update(id: string, operationId: string, fingerprint: string,
        change: (state: KanbanState | null) => KanbanState): Promise<KanbanState>;
}
export interface KanbanModuleOptions {
    /** Select definition references for a fresh successor; never retain execution resources by default. */
    restartReferences?(references: readonly import('./contracts').KanbanExternalReference[]): import('./contracts').KanbanExternalReference[];
    /** Host supplies metadata within the authorized user's/project's session scope. */
    suggestions?(board: KanbanBoard, kind: import('./contracts').KanbanSuggestionKind, search: string, limit: number): Promise<import('./contracts').KanbanSuggestion[] | undefined>;
    verifyOutputs?(input: {stage?: 'observe' | 'accept'; board: KanbanBoard; itemId: string; dispatchId?: string; outputs: import('./contracts').KanbanArtifactRef[]}): Promise<boolean>;
    onCommitted?(boardId: string, service: import('./contracts').KanbanService, now: number): Promise<void>;
    store: KanbanStore;
    /** Trusted identity resolved by the host, never from command payloads. */
    actor: KanbanActor;
    /** Must validate project access, delegated authority and session registration. */
    authorize(input: { actor: KanbanActor; board: KanbanBoard; action: 'create' | 'read' | 'install-content' | KanbanCommand['type']; command?: KanbanCommand }): Promise<void>;
    /** Confirm an automated owner has settled before releasing responsibility. */
    verifyDeletion?(board: KanbanBoard): Promise<void>;
    verifyLifecycle?(board: KanbanBoard, command: KanbanCommand): Promise<void>;
    verifyRelease?(input: {actor: KanbanActor; board: KanbanBoard; item: import('./contracts').KanbanItem}): Promise<boolean>;
    now?: () => number;
    id?: () => string;
    log(event: { operationId: string; boardId?: string; sessionId?: string; stage: string; result: 'success' | 'failure'; code?: string; durationMs: number }): void;
}
export class KanbanError extends Error {
    constructor(readonly code: string) { super(code); this.name = 'KanbanError'; }
}

export class KanbanScanNotStartedError extends KanbanError {}
