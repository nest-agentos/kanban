import type {KanbanPlanning} from './planning';
export interface KanbanSourceRef {sessionId: string; messageId: string; revision: string; role: 'user' | 'assistant'}
export interface KanbanDiscoveryChange {
    action: 'create' | 'update' | 'link'; itemId: string; title: string; responsibility: string; acceptance: string;
    eligibleAgentIds?: string[]; eligiblePrincipals?: import('./configuration').KanbanPrincipal[]; sources: KanbanSourceRef[]; planning?: KanbanPlanning;
}
export interface KanbanDiscoveryBatch {
    records?: import('./context').KanbanRecordInput[];
    runId: string; leaseToken: string; changes: KanbanDiscoveryChange[]; checkpoints: Array<{sessionId: string; revision: string}>;
    autoCreate: boolean;
}
