import type {KanbanPresentation} from './ports';
import type {KanbanService, KanbanSuggestionQuery} from '../contracts';
import {KanbanSuggestionPicker} from './suggestion-picker';
import type {SuggestionField} from './suggestion-field';

/** Pickers follow rendered forms; replaced views cannot receive stale query results. */
export class KanbanSuggestions {
    private observer: MutationObserver;
    private fields = new Map<HTMLElement, KanbanSuggestionPicker>();
    constructor(private readonly root: HTMLElement, private readonly service: KanbanService | undefined, private readonly boardId: () => string, private readonly presentation: KanbanPresentation) {
        this.observer = new MutationObserver(() => this.sync());
        this.observer.observe(root, {childList: true, subtree: true}); this.sync();
    }
    private sync(): void {
        for (const [node, field] of this.fields) if (!this.root.contains(node)) {field.destroy(); this.fields.delete(node);}
        if (!this.service) return;
        for (const node of this.root.querySelectorAll<HTMLElement>('[data-kanban-suggest]')) {
            if (this.fields.has(node)) continue;
            const options = JSON.parse(node.dataset.kanbanSuggest!) as SuggestionField;
            const picker = new KanbanSuggestionPicker(node, options, (query: KanbanSuggestionQuery) => this.service!.suggest(this.boardId(), query), this.presentation);
            this.fields.set(node, picker);
        }
    }
    destroy(): void {this.observer.disconnect(); for (const field of this.fields.values()) field.destroy(); this.fields.clear();}
}
