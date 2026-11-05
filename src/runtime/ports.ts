import type {KanbanExternalReference} from '../contracts';

export interface KanbanRuntimeDiagnostic {
    operationId: string; stage: string; result: 'started' | 'success' | 'failure'; durationMs: number;
    code?: string; operation?: string; boardId?: string; itemId?: string; count?: number;
}
export interface KanbanJournalOptions {
    directory?: string;
    artifactScheme?: string;
    diagnostic?(event: KanbanRuntimeDiagnostic): void;
}
export interface KanbanReferencePolicy {
    resource: string; decision: string; execution: string; nativeExecution?: string; workspace?: string;
    inherit?(references: readonly KanbanExternalReference[]): KanbanExternalReference[];
}
export const defaultReferences: KanbanReferencePolicy = {
    resource: 'kanban-resource', decision: 'kanban-decision', execution: 'kanban-execution', workspace: 'kanban-workspace',
};

export interface KanbanResourceCatalog {
    system: string;
    decisionSystem?: string;
    list(): Promise<Array<{reference: KanbanExternalReference; label: string}>>;
    validate(references: readonly KanbanExternalReference[]): Promise<void>;
}

export interface KanbanWorkLogOptions {
    directory?: string;
    references?: KanbanReferencePolicy;
    label?(stage: string): string;
    diagnostic?(event: KanbanRuntimeDiagnostic): void;
    onRecord?(input: {boardId: string; itemId: string; record: import('../contracts').KanbanProjectRecord}): Promise<void>;
}
