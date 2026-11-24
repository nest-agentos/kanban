import type {KanbanRecordSummary,KanbanRecordPage} from './context';
import type {KanbanRecordConversation} from './record-conversation';
import type {KanbanExternalReference} from './configuration';
import type {KanbanBoardSummary} from './contracts';
import type {KanbanRecordResource} from './record-execution';
export type KanbanDecisionRow={kind:'record';value:KanbanRecordSummary;conversation?:KanbanRecordConversation;conversations?:KanbanRecordConversation[]}|{kind:'conversation';value:KanbanRecordConversation};
export const decisionSorts=['title-asc','title-desc','activity-desc','activity-asc','created-desc','created-asc','progress-asc','progress-desc','project-asc','project-desc','attention'] as const;
export type DecisionSort=typeof decisionSorts[number];
export const DEFAULT_DECISION_SORT:DecisionSort='activity-desc';
export const decisionFilterStates=['attention','waiting','running','completed','needs-action','checking','failed','draft','cancelling','cancelled','rejected','superseded'] as const;
export type DecisionFilterState=typeof decisionFilterStates[number];
export const DECISION_SEARCH_LIMIT=160;
export interface KanbanDecisionFilters {search?:string;resources?:KanbanExternalReference[];states?:DecisionFilterState[];includeArchived?:boolean;attentionOnly?:boolean;}
export interface KanbanDecisionQuery extends KanbanDecisionFilters {resource?:KanbanExternalReference;cursor?:string;sort?:DecisionSort;archived?:boolean;recurring?:boolean;sections?:Array<'page'|'catalog'|'projects'>;locale?:string}
export interface KanbanDecisionPage extends KanbanRecordPage {decisionRows:KanbanDecisionRow[];conversationCode?:string;conversationSignature?:string;attentionTotal?:number;dismissAvailable?:boolean;dismissConversationAvailable?:boolean}
export interface KanbanDecisionSnapshot {page?:KanbanDecisionPage;boards?:KanbanBoardSummary[];resources?:KanbanRecordResource[];resourceCode?:string;observedAt:number}

export const DECISION_SORT_PREFERENCE_KEY='kanban.decision-sort.v1';
export interface KanbanPreparedDecision {boardId:string;query:KanbanDecisionQuery;value?:KanbanDecisionSnapshot;code?:string}
