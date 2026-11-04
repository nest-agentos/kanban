import type {KanbanBoard, KanbanItem, KanbanExecutionSession, KanbanSessionAssociation, KanbanWorkflowState} from './contracts';
export interface KanbanSessionSource {
    /** Cold, authorized relations only; never submit or restore execution while listing. */
    related?(board: KanbanBoard, item: KanbanItem, workflow: KanbanWorkflowState): Promise<KanbanSessionAssociation[]>;
    authorizeBinding?(board: KanbanBoard, sessionId: string): Promise<void>;
    /** Must check access within the supplied board's user/project and authority. */
    inspect(board: KanbanBoard, sessionId: string): Promise<Omit<KanbanExecutionSession,'recent'>>;
}
