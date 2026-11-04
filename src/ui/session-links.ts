import type {KanbanPresentation} from './ports';
import {escapeHTML, escapeAttr} from './html';

export function sessionLink(ui: KanbanPresentation, id: string, label = id, url?: string): string {
    if (!url) return `<button type="button" data-session="${escapeAttr(id)}">${escapeHTML(label)}</button>`;
    return linkPair(ui, url, label, id);
}
export function linkPair(ui: KanbanPresentation, href: string, label: string, sessionId?: string): string {
    return `<span class="kanban__session-links"><a href="${escapeAttr(href)}"${sessionId ? ` data-session="${escapeAttr(sessionId)}" title="${escapeAttr(ui.text('openSessionInTab'))}"` : ''}>${escapeHTML(label)}</a></span>`;
}
