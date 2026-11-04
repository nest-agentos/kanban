import type {KanbanWorkResource} from '../contracts';
import type {KanbanPresentation} from './ports';
import {escapeHTML, escapeAttr} from './html';

export function workResourcesView(ui: KanbanPresentation, resources: KanbanWorkResource[]): string {
    if (!resources.length) return `<p>${escapeHTML(ui.text('none'))}</p>`;
    return resources.map(resource => `<article class="kanban__work-resource" data-work-resource="${escapeAttr(resource.id)}">
        <strong>${escapeHTML(resource.title)}</strong>${copy(ui, resource.title, ui.text('copyWorkResourceName'))} · ${escapeHTML(ui.text('workResourceState.' + resource.state))}
        <p><code>${escapeHTML(resource.location)}</code>${copy(ui, resource.location, ui.text('copyWorkResourcePath'))}</p>
        <dl>${resource.properties.map(row => `<dt>${escapeHTML(row.label)}</dt><dd>${escapeHTML(row.value)}${copy(ui, row.value, ui.text('copyValue') + ' · ' + row.label)}</dd>`).join('')}</dl>
        ${resource.reasons.map(reason => `<p>${escapeHTML(reasonLabel(ui, reason))}</p>`).join('')}
        <button type="button" data-action="cleanup-work-resource" data-resource="${escapeAttr(resource.id)}" data-version="${escapeAttr(resource.version)}" ${resource.canCleanup ? '' : 'disabled'}>${escapeHTML(ui.text('cleanupWorkResource'))}</button>
        </article>`).join('');
}
function copy(ui: KanbanPresentation, value: string, label: string): string {
    return `<button type="button" class="kanban__copy-button" data-action="copy-resource" data-copy="${escapeAttr(value)}" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}">${ui.icons.copy ?? escapeHTML(ui.text('copyValue'))}</button>`;
}
function reasonLabel(ui: KanbanPresentation, reason: string): string {
    const key = 'workResourceReason.' + reason, label = ui.text(key); return label.includes(key) ? reason : label;
}
