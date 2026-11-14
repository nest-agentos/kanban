import type {KanbanRecordSummary,KanbanRecordPage} from './context';
import type {KanbanRecordConversation} from './record-conversation';
import type {KanbanExternalReference} from './configuration';
import type {KanbanBoardSummary} from './contracts';
import type {KanbanRecordResource} from './record-execution';
export type KanbanDecisionRow={kind:'record';value:KanbanRecordSummary;conversation?:KanbanRecordConversation;conversations?:KanbanRecordConversation[]}|{kind:'conversation';value:KanbanRecordConversation};
export const decisionSorts=['activity-desc','activity-asc','created-desc','created-asc','progress-asc','progress-desc','project-asc','project-desc','attention'] as const;
export type DecisionSort=typeof decisionSorts[number];
export interface KanbanDecisionQuery {resource?:KanbanExternalReference;cursor?:string;sort?:DecisionSort;attentionOnly?:boolean;archived?:boolean;sections?:Array<'page'|'catalog'|'projects'>;locale?:string}
export interface KanbanDecisionPage extends KanbanRecordPage {decisionRows:KanbanDecisionRow[];conversationCode?:string;conversationSignature?:string;attentionTotal?:number;dismissAvailable?:boolean;dismissConversationAvailable?:boolean}
export interface KanbanDecisionSnapshot {page?:KanbanDecisionPage;boards?:KanbanBoardSummary[];resources?:KanbanRecordResource[];resourceCode?:string;observedAt:number}
