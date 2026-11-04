import type {KanbanItem} from './contracts';
export type KanbanSuggestionKind = 'item' | 'parent' | 'dependency' | 'area' | 'milestone' | 'decision' | 'session';
export interface KanbanSuggestionQuery {
    kind: KanbanSuggestionKind; search?: string; limit?: number; excludeItemId?: string; excludeIds?: string[]; childKind?: string;
}
export interface KanbanSuggestion {id: string; label: string; detail?: string; status?: KanbanItem['status']; archived?: boolean}
export interface KanbanSuggestionPage {revision: number; items: KanbanSuggestion[]; hasMore: boolean}
