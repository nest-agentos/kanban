import type {KanbanPresentation} from './ports';
import type {KanbanBoardSummary} from '../contracts';
import {referenceMenu} from './references';
import {escapeHTML, escapeAttr} from './html';

/** Detail and creation panels use the same compact navigation row. */
export function panelHeader(ui: KanbanPresentation, title: string, board?: KanbanBoardSummary,
    entity?: {id: string; number?: number; kind?: 'log' | 'decision'}): string {
    const label = escapeAttr(ui.text('close'));
    return `<header class="kanban__panel-header" data-titlebar><button type="button" class="kanban__panel-back" data-titlebar-back data-action="close-panel" aria-label="${label}" title="${label}">${ui.icons.back ?? ui.icons.close}</button>
        <h3 data-titlebar-title title="${escapeAttr(title)}">${escapeHTML(title)}</h3><span class="kanban__window-navigation" data-window-navigation></span>${board ? referenceMenu(ui, board, entity, `<p class="kanban__menu-title">${escapeHTML(title)}</p>`) : ''}</header>`;
}
