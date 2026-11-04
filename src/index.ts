export type {KanbanModuleHandle} from './module';
export {createKanbanModule} from './module';
export {SeqKanbanStore} from './store';
export {KanbanError} from './ports';
export type {KanbanStore, KanbanState, KanbanModuleOptions, KanbanReadView} from './ports';
export type {KanbanBodyStore} from './storage-codec';
export type {KanbanPlanning, KanbanItemSummary, KanbanArchivedItem, KanbanItemQuery, KanbanItemPage, KanbanOverview} from './contracts/planning';
export type {KanbanReferenceTarget} from './contracts/references';
export {kanbanReference} from './contracts/references';
export type {KanbanPrincipal, KanbanMember, KanbanWorkType, KanbanColumn, KanbanNotificationPolicy, KanbanExternalReference} from './contracts/configuration';
export {DEFAULT_KANBAN_WORK_TYPES} from './contracts/configuration';
export type {KanbanActor, KanbanEstimate, KanbanPolicy, KanbanParticipant, KanbanAssignment, KanbanItem, KanbanBoard, KanbanEvent, KanbanCommand, KanbanRequest, KanbanBoardSummary, KanbanService, KanbanBoardInput} from './contracts/contracts';
export type {KanbanSuggestionKind, KanbanSuggestionQuery, KanbanSuggestion, KanbanSuggestionPage} from './contracts/suggestions';
export type {KanbanSourceRef, KanbanDiscoveryChange, KanbanDiscoveryBatch} from './contracts/source';
export type {KanbanText, KanbanAmendment, KanbanProjectRecord, KanbanRecordInput, KanbanRecordSummary, KanbanRecordQuery, KanbanRecordPage} from './contracts/context';
export type {KanbanArtifactRef, KanbanWorkDefinition, KanbanWorkPlan, KanbanPublishedPlan, KanbanDispatch, KanbanWorkflowState, KanbanWorkflowCommand} from './contracts/workflow';

export {KanbanScanNotStartedError} from './ports';
export {createKanban} from './api';
export type {Kanban, KanbanCommit} from './api';
export {isKanbanEventRelevant} from './event-policy';

export {projectKanbanTask, taskStartAt, taskDue, taskEditing, TASK_START_DELAY_MS} from './contracts/task-projection';
