import type {KanbanItemOperation, KanbanItemOperations} from '../contracts';
import type {KanbanPresentation} from './ports';
import {escapeAttr, escapeHTML} from './html';
import {sessionLink} from './session-links';
export function itemOperationsView(ui: KanbanPresentation, view: KanbanItemOperations, sessionUrl?: (id: string) => string): string {
    return `<button type="button" data-action="refresh-item-operations">${escapeHTML(ui.text('operationRefresh'))}</button><h4>${escapeHTML(ui.text('operationsTitle'))}</h4>
        <ol class="kanban__operations">${view.operations.map(operation => operationCard(ui, view, operation, sessionUrl)).join('')}</ol>`;
}
function operationCard(ui: KanbanPresentation, view: KanbanItemOperations, operation: KanbanItemOperation, url?: (id: string) => string): string {
    const reason = operation.code ? ui.text('errors.' + operation.code) : '';
    return `<li data-operation-id="${escapeAttr(operation.id)}"><strong>${escapeHTML(operation.label)}</strong> · ${escapeHTML(ui.text('operationState.' + operation.state))}
        ${operation.reason ? `<p>${escapeHTML(operation.reason)}</p>` : ''}${operation.code ? `<p role="alert">${escapeHTML(reason.endsWith('errors.' + operation.code) ? operation.code : reason)}</p>` : ''}
        ${operation.summary ? `<pre class="kanban__operation-summary">${escapeHTML(operation.summary)}</pre>` : ''}
        ${operation.sessionId ? sessionLink(ui, operation.sessionId, ui.text('operationSession'), url?.(operation.sessionId)) : ''}
        <form data-form="item-operation" data-operation="${escapeAttr(operation.id)}" data-revision="${escapeAttr(view.revision)}">
        ${choices(ui, operation)}${operation.confirmation ? `<label><input type="checkbox" name="confirmed" required>${escapeHTML(operation.confirmation)}</label>` : ''}
        <button type="submit"${operation.enabled ? '' : ' disabled'}>${escapeHTML(operation.label)}</button></form>${configuration(ui, view, operation)}</li>`;
}
function choices(ui: KanbanPresentation, operation: KanbanItemOperation): string {
    return (operation.fields ?? []).map(field => `<label>${escapeHTML(field.label)}<select name="choice-${escapeAttr(field.id)}" required>
        <option value="">${escapeHTML(ui.text('operationChoose'))}</option>${field.choices.map(choice => `<option value="${escapeAttr(choice.id)}"${field.selected === choice.id ? ' selected' : ''}>${escapeHTML(choice.label + (choice.detail ? ' · ' + choice.detail : ''))}</option>`).join('')}</select></label>`).join('');
}
function configuration(ui: KanbanPresentation, view: KanbanItemOperations, operation: KanbanItemOperation): string {
    if (!operation.configurable) return '';
    return `<details><summary>${escapeHTML(ui.text('operationConfigure'))}</summary><form data-form="operation-binding" data-operation="${escapeAttr(operation.id)}" data-revision="${escapeAttr(view.revision)}">
        <label>${escapeHTML(ui.text('operationFlow'))}<select name="target" required><option value="">${escapeHTML(ui.text('operationChoose'))}</option>
        ${(view.targets ?? []).map(target => `<option value="${escapeAttr(JSON.stringify(target.reference))}"${JSON.stringify(target.reference) === JSON.stringify(operation.binding) ? ' selected' : ''}>${escapeHTML(target.label)}</option>`).join('')}</select></label>
        <button type="submit">${escapeHTML(ui.text('save'))}</button>${view.targets?.length ? '' : `<p>${escapeHTML(ui.text('operationNoFlows'))}</p>`}</form></details>`;
}
