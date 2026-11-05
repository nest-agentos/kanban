import type {KanbanExternalReference} from './configuration';
import type {KanbanItem} from './contracts';

export interface KanbanPlanning {
    kind: string; execution?: 'direct' | 'children'; dueAt?: number; parentId?: string; area?: string; milestone?: string;
    priority: number; dependencies: string[]; references: string[];
}
export interface KanbanItemSummary {
    deletedAt?: number;
    restartedFrom?: string;
    launch?: import('./task-state').KanbanLaunch; analysis?: import('./automation').KanbanAnalysisStatus;
    control?: import('./task-state').KanbanTaskControl; issues?: import('./task-state').KanbanTaskIssue[]; blocked?: KanbanItem['blocked'];
    task?: import('./task-state').KanbanTaskProjection;
    assignee?: {kind?: string; id: string};
    number?: number;
    discoveryFingerprint?: string; pendingAmendments?: number;
    id: string; title: string; status: KanbanItem['status']; revision: number; createdAt: number; updatedAt: number;
    externalRefs?: KanbanExternalReference[];
    planning: KanbanPlanning; sessionIds: string[]; closedAt?: number;
    archivedAt?: number; archiveReason?: string;
    progress?: {total: number; completed: number; cancelled: number; inProgress: number};
}
export interface KanbanArchivedItem {item: KanbanItem; archivedAt: number; reason: string}
export interface KanbanItemQuery {
    includeDeleted?: boolean;
    restartedFrom?: string;
    phase?: import('./task-state').KanbanTaskPhase;
    view?: 'ready' | 'backlog' | 'in-progress' | 'review' | 'closed' | 'proposed' | 'archive' | 'all';
    area?: string; milestone?: string; parentId?: string; kind?: KanbanPlanning['kind'];
    reference?: Pick<KanbanExternalReference, 'system' | 'id'>;
    sessionId?: string; search?: string; limit?: number; cursor?: string;
}
export interface KanbanItemPage {revision: number; total: number; items: KanbanItemSummary[]; nextCursor?: string}
export interface KanbanOverview {
    revision: number; visible: number; active: number; archived: number; ready: number; inProgress: number; backlog: number;
    proposed: number; closed: number; dueForReview: number;
    limits: {ready: number; inProgress: number; perAgent: number; perAssignee: number};
}
