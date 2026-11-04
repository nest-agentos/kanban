import {escapeAttr} from './html';
import type {KanbanBoardSummary, KanbanSuggestion, KanbanSuggestionKind} from '../contracts';
export interface SuggestionField {
    name: string; label: string; kind: KanbanSuggestionKind; selected?: KanbanSuggestion[];
    multiple?: boolean; free?: boolean; manual?: boolean; required?: boolean; excludeItemId?: string;
}
export function suggestionField(options: SuggestionField): string {
    return `<div class="kanban__suggest" data-kanban-suggest="${escapeAttr(JSON.stringify(options))}"></div>`;
}
export function selectedItems(board: KanbanBoardSummary, ids: string[]): KanbanSuggestion[] {
    return ids.map(id => ({id, label: board.items.find(item => item.id === id)?.title ?? id}));
}
