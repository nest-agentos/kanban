import type {KanbanPresentation} from './ports';
import {panelHeader} from './panel-header';
import {kanbanReference} from '../contracts';
import {suggestionField, selectedItems} from './suggestion-field';
import {escapeHTML, escapeAttr} from './html';
import type {KanbanBoardSummary, KanbanItem, KanbanProjectRecord, KanbanRecordPage, KanbanSourceRef} from '../contracts';
import {button, field, textarea, contextTabs, boardHeader} from './view';
export function recordsView(ui: KanbanPresentation, page: KanbanRecordPage, kind: KanbanProjectRecord['kind'], hasPrevious: boolean, board?: KanbanBoardSummary): string {
    return `${board ? boardHeader(ui, board, kind) : `<header class="kanban__toolbar"><h2>${escapeHTML(ui.text(kind))}</h2></header>`}
        ${contextTabs(ui, kind)}<p>${escapeHTML(ui.text('recordHelp'))}</p><div class="kanban__record-list" tabindex="0" aria-label="${escapeAttr(ui.text(kind))}">${recordLinks(ui, page, board)}${!page.total ? `<p>${escapeHTML(ui.text('emptyRecords'))}</p>` : ''}</div>
        <footer class="kanban__toolbar">${hasPrevious ? button(ui, 'records-first', 'first') : ''}${page.nextCursor ? button(ui, 'records-next', 'next') : ''}</footer>`;
}
export function recordLinks(ui: KanbanPresentation, page: KanbanRecordPage, board?: KanbanBoardSummary): string {
    return page.items.map(record => `<button type="button" class="kanban__card" data-record="${escapeAttr(record.id)}"><strong>${escapeHTML(record.title)}</strong>${board && !record.activity ? `<small>${escapeHTML(kanbanReference(board, record))}</small>` : ''}<small>${escapeHTML(ui.text(record.activity ? 'automaticLog' : record.kind))} · ${escapeHTML(ui.text(record.status))} · ${escapeHTML(new Date(record.createdAt).toLocaleString())}</small></button>`).join('');
}
export function sourcesView(ui: KanbanPresentation, sources: KanbanSourceRef[]): string {
    return sources.length ? `<ul>${sources.map(source => `<li><button type="button" data-session="${escapeAttr(source.sessionId)}">${escapeHTML(source.sessionId)}</button><small>${escapeHTML(source.messageId)} · ${escapeHTML(source.revision)} · ${escapeHTML(source.role)}</small></li>`).join('')}</ul>` : `<p>${escapeHTML(ui.text('noSources'))}</p>`;
}
export function recordForm(ui: KanbanPresentation, kind: KanbanProjectRecord['kind'], board: KanbanBoardSummary, itemId = '', resources: import('../contracts').KanbanRecordResource[] = []): string {
    return `${panelHeader(ui, ui.text(kind === 'log' ? 'newLog' : 'newDecision'))}<form data-form="record">
        <input type="hidden" name="kind" value="${kind}">${field(ui, 'title', 'name')}${textarea(ui, 'content', 'content')}${kind === 'decision' ? textarea(ui, 'rationale', 'rationale') + suggestionField({name: 'supersedes', label: 'supersedes', kind: 'decision'}) : ''}
        ${kind === 'decision' && resources.length ? `<label>${escapeHTML(ui.text('recordResources'))}<select name="recordResources" multiple>${resources.map(resource => `<option value="${escapeAttr(JSON.stringify(resource.reference))}">${escapeHTML(resource.label)}</option>`).join('')}</select></label>` : ''}
        ${itemChoices(board, itemId)}<details><summary>${escapeHTML(ui.text('sources'))}</summary>${suggestionField({name: 'sourceSession', label: 'sourceSession', kind: 'session', manual: true})}${field(ui, 'sourceMessage', 'sourceMessage', '', false)}${field(ui, 'sourceRevision', 'sourceRevision', '', false)}</details><button>${escapeHTML(ui.text('save'))}</button></form>`;
}
export function recordDetail(ui: KanbanPresentation, record: KanbanProjectRecord, board: KanbanBoardSummary, executions?: import('../contracts').KanbanRecordExecution[]): string {
    return `${panelHeader(ui, record.title, board, record)}
        <p>${escapeHTML(ui.text(record.kind))} · ${escapeHTML(ui.text(record.status))} · ${escapeHTML(ui.text(record.origin))}</p>${record.activity ? '' : `<small>${escapeHTML(ui.text('recordId'))}: ${escapeHTML(record.id)}</small>`}<p>${escapeHTML(ui.text('author'))}: ${escapeHTML(record.author.id)} · ${escapeHTML(new Date(record.createdAt).toLocaleString())}</p>
        <section data-reference-links></section><section class="kanban__prose"><h4>${escapeHTML(ui.text('content'))}</h4><p>${escapeHTML(record.content)}</p>${record.rationale ? `<h4>${escapeHTML(ui.text('rationale'))}</h4><p>${escapeHTML(record.rationale)}</p>` : ''}</section>
        ${record.status === 'draft' ? `<div class="kanban__actions">${button(ui, 'confirm-record', 'confirmRecord')}${button(ui, 'reject-record', 'rejectRecord')}</div>` : ''}
        ${record.kind === 'decision' && record.status === 'confirmed' && executions ? recordExecutionView(ui, board, executions) : ''}
        ${(record.externalRefs ?? []).map(ref => `<p>${escapeHTML(ref.system)}: ${escapeHTML(ref.id)}</p>`).join('')}
        ${record.supersedes ? recordLink(ui, record.supersedes, 'supersedes') : ''}${record.supersededBy ? recordLink(ui, record.supersededBy, 'superseded') : ''}
        <h4>${escapeHTML(ui.text('itemIds'))}</h4>${record.itemIds.map(id => `<button type="button" data-item="${escapeAttr(id)}">${escapeHTML(board.items.find(item => item.id === id)?.title ?? id)}</button>`).join('')}
        ${record.activity ? '' : `<form data-form="record-link">${suggestionField({name: 'itemId', label: 'itemIds', kind: 'item', required: true})}<button>${escapeHTML(ui.text('linkRecord'))}</button></form>`}<h4>${escapeHTML(ui.text('sources'))}</h4>${sourcesView(ui, record.sources)}`;
}
function recordExecutionView(ui: KanbanPresentation, board: KanbanBoardSummary, executions: import('../contracts').KanbanRecordExecution[]): string {
    const completed = executions.some(run => run.state === 'completed');
    const actions = completed ? `<p>${escapeHTML(ui.text('completedFollowup'))}</p>`
        : `${button(ui, 'run-record', 'runRecord')}<details><summary>${escapeHTML(ui.text('referenceActions'))}</summary>${button(ui, 'run-record-separate', 'runRecordSeparate')}</details>`;
    return `<div class="kanban__actions">${actions}</div>${completed ? '' : `<p>${escapeHTML(ui.text('runRecordHelp'))}</p>`}
        ${executions.map(run => `<p><button type="button" ${run.rootItemId && run.boardId === board.id ? `data-item="${escapeAttr(run.rootItemId)}"` : `data-board="${escapeAttr(run.boardId)}"`}>${escapeHTML(ui.text(run.rootItemId && run.boardId === board.id ? 'executionWork' : 'executionBoard'))}</button> · ${escapeHTML(ui.text(run.state))}${run.code ? ` · ${escapeHTML(run.code)}` : ''}</p>`).join('')}`;
}
function recordLink(ui: KanbanPresentation, id: string, key: string): string {return `<p>${escapeHTML(ui.text(key))}: <button type="button" data-record="${escapeAttr(id)}">${escapeHTML(id)}</button></p>`;}
export function amendmentsView(ui: KanbanPresentation, item: KanbanItem): string {
    const pending = item.amendments?.filter(proposal => proposal.status === 'pending') ?? [];
    if (!pending.length) return '';
    return `<section class="kanban__amendments"><h4>${escapeHTML(ui.text('amendments'))}</h4><p>${escapeHTML(ui.text('amendmentHint'))}</p>${pending.map(proposal => `<article><strong>${escapeHTML(proposal.proposedBy.id)}</strong><small> v${proposal.baseRevision}</small>
        <details><summary>${escapeHTML(ui.text('currentText'))}</summary><p>${escapeHTML(item.title)}</p><p>${escapeHTML(item.responsibility)}</p><p>${escapeHTML(item.acceptance)}</p></details>
        <h5>${escapeHTML(ui.text('proposedText'))}</h5><p>${escapeHTML(proposal.proposed.title)}</p><p>${escapeHTML(proposal.proposed.responsibility)}</p><p>${escapeHTML(proposal.proposed.acceptance)}</p>
        ${sourcesView(ui, proposal.sources)}<form data-form="amendment" data-amendment="${escapeAttr(proposal.id)}"><select name="decision" aria-label="${escapeAttr(ui.text('amendments'))}"><option value="accept">${escapeHTML(ui.text('applyAmendment'))}</option><option value="reject">${escapeHTML(ui.text('rejectAmendment'))}</option></select>${field(ui, 'reason', 'reason', '', false)}<button>${escapeHTML(ui.text('save'))}</button></form></article>`).join('')}</section>`;
}

function itemChoices( board: KanbanBoardSummary, itemId: string): string {
    return suggestionField({name: 'itemIds', label: 'itemIds', kind: 'item', multiple: true, selected: selectedItems(board, itemId ? [itemId] : [])});
}
