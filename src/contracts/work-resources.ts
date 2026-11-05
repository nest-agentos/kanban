/** Host-owned execution resources; the coordination library does not interpret their backend. */
export interface KanbanWorkResource {
    id: string; kind: string; title: string; location: string; version: string;
    archivedAt?:number;
    ownership?: 'current' | 'other' | 'unknown';
    state: 'associated' | 'in-use' | 'retained' | 'cleanup-ready' | 'cleaned' | 'unknown';
    reasons: string[]; properties: Array<{label: string; value: string}>;
    canCleanup: boolean;
}
export interface KanbanWorkResourceQuery {inspect?: boolean}
export interface KanbanWorkResourceCleanup {
    operationId: string; itemId: string; resourceId: string; version: string;
}
