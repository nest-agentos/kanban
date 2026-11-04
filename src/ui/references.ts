import type {KanbanPresentation} from './ports';
import {escapeHTML, escapeAttr} from './html';
import {kanbanReference, type KanbanBoardSummary} from '../contracts';

export function referenceView(ui: KanbanPresentation, board: KanbanBoardSummary, entity?: {id: string; number?: number; kind?: 'log' | 'decision'}): string {
    return `<div class="kanban__reference"><code>${escapeHTML(kanbanReference(board, entity))}</code>${referenceMenu(ui, board, entity)}</div>`;
}
export function referenceMenu(ui: KanbanPresentation, board: KanbanBoardSummary, entity?: {id: string; number?: number; kind?: 'log' | 'decision'}, actions = ''): string {
    const reference = kanbanReference(board, entity);
    const path = `/board/${encodeURIComponent(board.id)}${entity ? entity.kind ? '/@record/' + encodeURIComponent(entity.id) : '/' + encodeURIComponent(entity.id) : ''}`;
    return `<details class="kanban__menu" data-popover><summary aria-label="${escapeAttr(ui.text('referenceActions'))}" title="${escapeAttr(ui.text('referenceActions'))}">${ui.icons.more}</summary>
        <div class="kanban__menu-content"><code class="kanban__menu-reference">${escapeHTML(reference)}</code>${actions}<button type="button" data-action="copy-reference" data-copy="${escapeAttr(reference)}">${escapeHTML(ui.text('copyReference'))}</button>
        <button type="button" data-action="copy-link" data-copy="${escapeAttr(path)}">${escapeHTML(ui.text('copyLink'))}</button></div></details>`;
}
export async function copyReference(ui: KanbanPresentation, button: HTMLElement): Promise<void> {
    const value = button.dataset.copy ?? '';
    const text = button.dataset.action === 'copy-link' ? ui.referenceUrl?.(value) ?? value : value;
    try {
        await navigator.clipboard.writeText(text);
        if (button.dataset.action === 'copy-resource') {button.title = ui.text('copied'); button.setAttribute('aria-label', ui.text('copied'));}
        else button.textContent = ui.text('copied');
    }
    catch {throw Object.assign(new Error(ui.text('copyFailed')), {code:'COPY_FAILED'});}
}
