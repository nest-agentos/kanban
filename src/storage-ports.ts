/** A transport snapshot is pinned to one revision; unknown writes must not be replayed. */
export interface KanbanSeqSnapshot {
    revision: string | null;
    entries: Array<{key: string; value: unknown}>;
}
export type KanbanSeqChange = {action: 'set'; key: string; value: string} | {action: 'delete'; key: string};
export interface KanbanSeqClient {
    query(path: string, query: {keys: string[]; expectedRevision?: string}): Promise<KanbanSeqSnapshot>;
    transaction(path: string, expectedRevision: string | null, changes: KanbanSeqChange[]): Promise<unknown>;
    readBody?(path: string, hash: string): Promise<ArrayBuffer | null>;
    writeBody?(path: string, hash: string, bytes: ArrayBuffer): Promise<void>;
}
