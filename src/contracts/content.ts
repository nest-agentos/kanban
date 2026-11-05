import type {KanbanActor, KanbanBoardInput, KanbanCommand} from './contracts';
import type {KanbanRecordInput, KanbanText} from './context';
export interface KanbanContentItem {
    introduced?: number;
    command: Extract<KanbanCommand, {type: 'create-item'}> & {item:{id:string}};
    blocked?: string;
    completion?: {resultRef: string; archiveReason?: string};
}
export interface KanbanContentRecord {introduced?: number; record: KanbanRecordInput; confirmed?: boolean}
export interface KanbanContentAmendment extends KanbanText {
    introduced?: number; itemId: string; runId: string; proposedBy: KanbanActor;
}
/** Versioned host-provided content; contains no product presets or execution grants. */
export interface KanbanContent {
    id: string; version: number; board: KanbanBoardInput;
    items: KanbanContentItem[]; records?: KanbanContentRecord[]; amendments?: KanbanContentAmendment[];
}
