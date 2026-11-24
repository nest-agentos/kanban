import type {KanbanActor} from './contracts';

export interface KanbanDeferredVerification {
    id: string;
    title: string;
    instructions: string;
    itemId?: string;
    createdAt: number;
    actor: KanbanActor;
    result?: {outcome: 'passed' | 'failed'; evidence: string; verifiedAt: number; actor: KanbanActor};
}

export type KanbanVerificationCommand =
    | {type: 'defer-verification'; verification: Pick<KanbanDeferredVerification, 'id' | 'title' | 'instructions' | 'itemId'>}
    | {type: 'record-verification-result'; verificationId: string; outcome: 'passed' | 'failed'; evidence: string};
