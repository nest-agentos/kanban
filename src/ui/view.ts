import {taskStatus, phaseFilter} from './task-state';
import type {KanbanPresentation} from './ports';
import {referenceMenu} from './references';
import {kanbanReference} from '../contracts';
import {suggestionField} from './suggestion-field';
import {escapeHTML, escapeAttr} from './html';
import type {KanbanBoardSummary, KanbanItem, KanbanSessionItemPage, KanbanSessionActivityQuery, KanbanPrincipal} from '../contracts';
import {executionBadge,executionFilter} from './session-view';

export const states: KanbanItem['status'][] = ['proposed', 'backlog', 'open', 'claimed', 'review', 'completed', 'cancelled'];
export const button = (ui: KanbanPresentation, action: string, key: string, primary = false) => `<button type="button"${primary ? ' class="kanban__primary"' : ''} data-action="${escapeAttr(action)}">${escapeHTML(ui.text(key))}</button>`;
export function contextTabs(ui: KanbanPresentation, active = 'board'): string {
    return `<nav class="kanban__context-tabs" aria-label="${escapeAttr(ui.text('recordContext'))}">${[['board', 'tabBoard'], ['log', 'tabLog'], ['decision', 'tabDecision']].map(([value, key]) =>
        `<button type="button" data-context="${value}" ${active === value ? 'aria-current="page"' : ''}>${escapeHTML(ui.text(key))}</button>`).join('')}</nav>`;
}
export function field(ui: KanbanPresentation, name: string, key: string, value = '', required = true, type = 'text'): string {
    return `<label>${escapeHTML(ui.text(key))}<input name="${name}" type="${type}" value="${escapeAttr(value)}" ${required ? 'required' : ''}></label>`;
}
export function textarea(ui: KanbanPresentation, name: string, key: string, value = ''): string {
    return `<label>${escapeHTML(ui.text(key))}<textarea name="${name}" required>${escapeHTML(value)}</textarea></label>`;
}
export function owns(item: KanbanItem, actor?: KanbanPrincipal): boolean {
    return !!actor && !!item.owner && (item.owner.kind ?? 'agent') === actor.kind && (item.owner.id ?? item.owner.agentId) === actor.id;
}
export function navigation(ui: KanbanPresentation, boards: KanbanBoardSummary[], selected: string): string {
    return `<header class="kanban__sidebar-header"><h2>${escapeHTML(ui.text('title'))}</h2>${button(ui, 'new-board', 'createShort')}</header>
        <section class="kanban__board-list"><p class="kanban__caption">${escapeHTML(ui.text('scope'))}</p><nav aria-label="${escapeAttr(ui.text('title'))}">${boards.map(board =>
            `<button type="button" data-board="${escapeAttr(board.id)}" ${board.id === selected ? 'aria-current="page"' : ''}><small>${escapeHTML(kanbanReference(board))}</small><span>${escapeHTML(board.title)}</span></button>`).join('')}</nav></section>
        <footer class="kanban__sidebar-tools"><details class="kanban__reference-lookup"><summary>${escapeHTML(ui.text('openReference'))}</summary>${referenceLookup(ui)}</details>
        <details class="kanban__scope-note"><summary>${escapeHTML(ui.text('scopeInfo'))}</summary><p>${escapeHTML(ui.text('scopeHelp'))}</p></details></footer>`;
}
export function referenceLookup(ui: KanbanPresentation): string {
    return `<form data-form="reference"><input name="reference" aria-label="${escapeAttr(ui.text('reference'))}" placeholder="${escapeAttr(ui.text('referencePlaceholder'))}" required><button>${escapeHTML(ui.text('openShort'))}</button></form>`;
}
export function boardHeader(ui: KanbanPresentation, board: KanbanBoardSummary, active = 'board', automation = false): string {
    const [action, key] = active === 'log' ? ['new-log', 'newLog'] : active === 'decision' ? ['new-decision', 'newDecision'] : ['new-item', 'newItem'];
    const actions = `<div class="kanban__mobile-create">${button(ui, action, key)}</div>${button(ui, 'refresh', 'refresh')}${automation ? button(ui, 'automation', 'automationTitle') : ''}`;
    return `<header class="kanban__page-header" data-titlebar><span class="kanban__navigation" data-navigation></span><div class="kanban__board-heading"><h2 data-titlebar-title title="${escapeAttr(board.title)}">${escapeHTML(board.title)}</h2></div>
        <div class="kanban__header-actions"><span class="kanban__desktop-create">${button(ui, action, key, true)}</span><span class="kanban__window-navigation" data-window-navigation></span>${referenceMenu(ui, board, undefined, actions)}</div></header>`;
}
export function catalogView(ui: KanbanPresentation, boards: KanbanBoardSummary[]): string {
    return `<header class="kanban__page-header" data-titlebar><span class="kanban__navigation" data-navigation></span><div class="kanban__board-heading"><h2 data-titlebar-title>${escapeHTML(ui.text('title'))}</h2></div><span class="kanban__window-navigation" data-window-navigation></span>${button(ui, 'new-board', 'createShort')}</header>
        <div class="kanban__record-list">${boards.map(board => `<button type="button" class="kanban__card" data-board="${escapeAttr(board.id)}"><strong>${escapeHTML(board.title)}</strong><small>${escapeHTML(kanbanReference(board))}</small></button>`).join('') || `<p>${escapeHTML(ui.text('emptyBoards'))}</p>`}</div>`;
}
export function boardView(ui: KanbanPresentation, board: KanbanBoardSummary, page: KanbanSessionItemPage, query: KanbanSessionActivityQuery, activity = false, automation = false, sessionUrl?: (id:string)=>string): string {
    const columns = query.view === 'archive' ? [{id: 'archive', label: ui.text('archive'), states}] : board.columns ?? states.map(state => ({id: state, label: ui.text(state), states: [state]}));
    return `${boardHeader(ui, board, 'board', automation)}${contextTabs(ui)}<form data-form="filter" class="kanban__filters"><input name="search" aria-label="${escapeAttr(ui.text('search'))}" placeholder="${escapeAttr(ui.text('search'))}" value="${escapeAttr(query.search ?? '')}">
        <details class="kanban__filter-more" data-popover><summary>${escapeHTML(ui.text('moreFilters'))}${query.area || query.milestone || query.view !== 'all' || query.execution && query.execution !== 'all' ? '<span class="kanban__filter-dot" aria-hidden="true"></span>' : ''}</summary><div class="kanban__filter-fields"><label>${escapeHTML(ui.text('filter'))}<select name="view" aria-label="${escapeAttr(ui.text('filter'))}">${['all', 'backlog', 'ready', 'in-progress', 'review', 'closed', 'proposed', 'archive'].map(view => `<option value="${view}" ${view === query.view ? 'selected' : ''}>${escapeHTML(ui.text(view === 'ready' ? 'open' : view === 'in-progress' ? 'claimed' : view === 'closed' ? 'completed' : view))}</option>`).join('')}</select></label>${phaseFilter(ui,query.phase)}${activity ? executionFilter(ui, query.execution) : ''}${suggestionField({name: 'area', label: 'area', kind: 'area', free: true, selected: query.area ? [{id: query.area, label: query.area}] : []})}
        ${suggestionField({name: 'milestone', label: 'milestone', kind: 'milestone', free: true, selected: query.milestone ? [{id: query.milestone, label: query.milestone}] : []})}</div></details><button>${escapeHTML(ui.text('filter'))}</button></form>
        <p class="kanban__count" role="status">${escapeHTML(ui.text('total', {count: page.total}))}</p><div class="kanban__columns" data-has-items="${page.items.length > 0}">${columns.map(column => {
            const items = page.items.filter(item => column.states.includes(item.status));
            return `<section class="kanban__column" data-empty="${items.length === 0}"><h3>${escapeHTML(column.label)} <small>${items.length}</small></h3><div class="kanban__column-items" data-column="${escapeAttr(column.id)}" tabindex="0" aria-label="${escapeAttr(column.label + ' · ' + ui.text('columnItems'))}">${items.map(item=>itemCard(ui,board,item,sessionUrl)).join('') || `<p>${escapeHTML(ui.text('emptyItems'))}</p>`}</div></section>`;
        }).join('')}</div><footer class="kanban__toolbar"><small>${escapeHTML(ui.text('scrollHint'))}</small>${button(ui, 'scroll-left', 'previousColumns')}${button(ui, 'scroll-right', 'nextColumns')}${query.cursor ? button(ui, 'first', 'first') : ''}${page.nextCursor ? button(ui, 'next', 'next') : ''}</footer>`;
}

function itemCard(ui:KanbanPresentation,board:KanbanBoardSummary,item:KanbanSessionItemPage['items'][number],sessionUrl?: (id:string)=>string):string {
    const content=`<strong>${escapeHTML(item.title)}</strong><small>${escapeHTML(kanbanReference(board, item))}</small><small>P${item.planning.priority} · ${escapeHTML(item.planning.area ?? '')} · ${escapeHTML(item.planning.milestone ?? '')}</small>${taskStatus(ui,item.task)}${item.pendingAmendments ? `<small class="kanban__badge">${escapeHTML(ui.text('pendingAmendments'))} (${item.pendingAmendments})</small>` : ''}${item.progress ? `<small>${item.progress.completed}/${item.progress.total}</small>` : ''}`;
    const identity=item.task?.sessionId?`data-session="${escapeAttr(item.task.sessionId)}"`:`data-item="${escapeAttr(item.id)}"`;
    return `<article class="kanban__card"><button type="button" class="kanban__item-open" ${identity}>${content}</button>${item.task?.sessionId?`<button type="button" data-item="${escapeAttr(item.id)}" title="${escapeAttr(ui.text('details'))}" aria-label="${escapeAttr(ui.text('details'))}">${escapeHTML(ui.text('details'))}</button>`:''}<span data-item-execution="${escapeAttr(item.id)}">${executionBadge(ui,item.execution,sessionUrl)}</span></article>`;
}
