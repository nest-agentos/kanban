import {projectKanbanTask} from '../contracts/task-projection';
import {taskControls, taskStatus} from './task-state';
import {executableWorkItem, DEFAULT_KANBAN_WORK_TYPES} from '../contracts';
import type {KanbanPresentation, KanbanReviewGuidance} from './ports';
import {childType} from './children';
import {panelHeader} from './panel-header';
import {suggestionField, selectedItems} from './suggestion-field';
import {amendmentsView, sourcesView} from './context-view';
import {escapeHTML, escapeAttr} from './html';
import type {KanbanBoardSummary, KanbanEvent, KanbanItem, KanbanPrincipal, KanbanPlanning, KanbanItemResourceCatalog} from '../contracts';
import {button, field, textarea, owns} from './view';
import {meaningfulItemEvents} from './event-history';

export function newBoardForm(ui: KanbanPresentation): string {
    return `${panelHeader(ui, ui.text('newBoard'))}<form data-form="board">${field(ui, 'title', 'boardName')}
        <label><input name="requireEstimate" type="checkbox">${escapeHTML(ui.text('requireEstimate'))}</label>
        ${save(ui)}</form>`;
}
export function newItemForm(ui: KanbanPresentation, board: KanbanBoardSummary, parent?: KanbanItem, resources?:KanbanItemResourceCatalog): string {
    const preset: KanbanPlanning | undefined = parent ? {kind: childType(board, parent)!, parentId: parent.id, priority: parent.planning?.priority ?? 2, dependencies: [], references: []} : undefined;
    return `${panelHeader(ui, ui.text('newItem'))}<form data-form="item">${field(ui, 'title', 'name')}
        ${textarea(ui, 'responsibility', 'responsibility')}${textarea(ui, 'acceptance', 'acceptance')}${launchModeField(ui)}${planningFields(ui, board, undefined, preset)}${itemResourceField(ui,resources,(board.workTypes??DEFAULT_KANBAN_WORK_TYPES).some(type=>type.id===(preset?.kind??board.defaultWorkType??'task')&&type.executable))}${save(ui)}</form>`;
}
export function planningFields(ui: KanbanPresentation, board: KanbanBoardSummary, item?: KanbanItem, preset?: KanbanPlanning): string {
    const plan = preset ?? item?.planning, types = board.workTypes ?? DEFAULT_KANBAN_WORK_TYPES;
    return `<label>${escapeHTML(ui.text('type'))}<select name="kind">${types.map(type => `<option data-executable="${type.executable}" value="${escapeAttr(type.id)}" ${type.id === (plan?.kind ?? board.defaultWorkType ?? 'task') ? 'selected' : ''}>${escapeHTML(type.label)}</option>`).join('')}</select></label>
        ${field(ui, 'priority', 'priority', String(plan?.priority ?? 2), true, 'number')}
        ${suggestionField({name: 'area', label: 'area', kind: 'area', free: true, selected: plan?.area ? [{id: plan.area, label: plan.area}] : []})}${suggestionField({name: 'milestone', label: 'milestone', kind: 'milestone', free: true, selected: plan?.milestone ? [{id: plan.milestone, label: plan.milestone}] : []})}
        ${suggestionField({name: 'parentId', label: 'parent', kind: 'parent', excludeItemId: item?.id, selected: selectedItems(board, plan?.parentId ? [plan.parentId] : [])})}${suggestionField({name: 'dependencies', label: 'dependencies', kind: 'dependency', multiple: true, excludeItemId: item?.id, selected: selectedItems(board, plan?.dependencies ?? [])})}
        ${field(ui, 'dueAt', 'dueAt', dateInput(plan?.dueAt), false, 'datetime-local')}`;
}
function dateInput(at?: number): string {
    if (at === undefined) return '';
    const date = new Date(at); return new Date(at - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
const save = (ui: KanbanPresentation) => `<div class="kanban__actions"><button>${escapeHTML(ui.text('save'))}</button>${button(ui, 'close-panel', 'close')}</div>`;
export function detailView(ui: KanbanPresentation, board: KanbanBoardSummary, item: KanbanItem, actor: KanbanPrincipal | undefined, archived: boolean, events: KanbanEvent[], relatedSessions = false, guidance?: KanbanReviewGuidance, interactive = false, task = projectKanbanTask(item), fixAvailable = false): string {
    return `${panelHeader(ui, item.title, board, item)}${taskStatus(ui, task)}${archived ? '' : `<div class="kanban__actions">${taskControls(ui,task,fixAvailable)}</div>`}
        <p>${escapeHTML(ui.text('origin'))}: ${escapeHTML(item.origin ? ui.text(item.origin.kind === 'discovery' ? 'flow' : 'manual') + ' · ' + item.origin.principal.id : ui.text('unknownOrigin'))}</p>
        <dl><dt>${escapeHTML(ui.text('itemId'))}</dt><dd>${escapeHTML(item.id)}</dd><dt>${escapeHTML(ui.text('responsibility'))}</dt><dd>${escapeHTML(item.responsibility)}</dd>
        <dt>${escapeHTML(ui.text('acceptance'))}</dt><dd>${escapeHTML(item.acceptance)}</dd><dt>${escapeHTML(ui.text('owner'))}</dt><dd>${escapeHTML(item.owner?.id ?? item.owner?.agentId ?? ui.text('none'))}</dd></dl>
        <p>${escapeHTML(ui.text(item.status))}${item.blocked ? ' · ' + escapeHTML(ui.text('blocked') + ': ' + item.blocked.reason) : ''}</p>
        ${interactive ? '<section data-item-operations></section>' : ''}
        ${item.status === 'review' ? interactive ? `<details><summary>${escapeHTML(ui.text('reviewFlow'))}</summary>${reviewGuidance(ui, guidance)}</details>` : reviewGuidance(ui, guidance) : ''}
        <div class="kanban__actions">${controls(ui, board, item, actor, archived, interactive)}</div>
        ${item.issues?.filter(issue=>!issue.resolvedBy).map(issue=>`<form data-form="task-reply"><input type="hidden" name="attemptId" value="${escapeAttr(issue.attemptId)}"><input type="hidden" name="replyTo" value="${escapeAttr(issue.id)}">${textarea(ui,'content','message')}<button>${escapeHTML(ui.text('send'))}</button></form>`).join('') ?? ''}
        ${amendmentsView(ui, item)}
        ${archived ? '' : detailForms(ui, board, item, actor)}
        ${(item.planning?.dependencies ?? []).length ? `<p>${escapeHTML(ui.text('dependencies'))}: ${(item.planning?.dependencies ?? []).map(id => `<button type="button" data-item="${escapeAttr(id)}">${escapeHTML(board.items.find(i => i.id === id)?.title ?? id)}</button>`).join(' ')}</p>` : ''}
        ${item.planning?.parentId ? `<p>${escapeHTML(ui.text('parent'))}: <button type="button" data-item="${escapeAttr(item.planning.parentId)}">${escapeHTML(board.items.find(parent => parent.id === item.planning?.parentId)?.title ?? item.planning.parentId)}</button></p>` : ''}
        <section data-children></section><section data-related-records></section><h4>${escapeHTML(ui.text('sources'))}</h4>${sourcesView(ui, item.sources ?? [])}
        <div data-analysis></div><div data-execution-session></div><section data-related-sessions-section></section><section data-reference-links></section><section data-work-resource-section></section>
        ${relatedSessions ? '' : `<h4>${escapeHTML(ui.text('sessions'))}</h4>${item.participants.map(p => `<button type="button" data-session="${escapeAttr(p.sessionId)}">${escapeHTML(p.sessionId)} · ${escapeHTML(p.roles.join(', '))}</button>`).join('') || `<p>${escapeHTML(ui.text('none'))}</p>`}`}
        ${archived ? '' : `<details><summary>${escapeHTML(ui.text('registerSession'))}</summary><p>${escapeHTML(ui.text('registerSessionHelp'))}</p><form data-form="session">${suggestionField({name: 'sessionId', label: 'session', kind: 'session', manual: true, required: true})}<button>${escapeHTML(ui.text('registerSession'))}</button></form></details>`}
        <section data-item-events>${itemEventsView(ui, events)}</section>`;
}
function reviewGuidance(ui: KanbanPresentation, guidance?: KanbanReviewGuidance): string {
    const [summary, ...steps] = guidance?.paragraphs ?? [ui.text('reviewHelp')];
    return `<section class="kanban__review-guide"><strong>${escapeHTML(guidance?.title ?? ui.text('reviewHelpTitle'))}</strong><p>${escapeHTML(summary)}</p>
        ${steps.length ? `<details><summary>${escapeHTML(ui.text('reviewFlow'))}</summary><ol>${steps.map(text => `<li>${escapeHTML(text)}</li>`).join('')}</ol></details>` : ''}</section>`;
}
export function itemEventsView(ui: KanbanPresentation, events: KanbanEvent[]): string {
    return `<details><summary>${escapeHTML(ui.text('eventsHelp'))}</summary><ol>${meaningfulItemEvents(events).map(event => `<li>${escapeHTML(event.kind)} · ${escapeHTML(event.actor.id ?? event.actor.agentId ?? '')} · ${escapeHTML(new Date(event.at).toLocaleString())}${event.data.message ? `<p>${escapeHTML(event.data.message)}</p>` : ''}</li>`).join('')}</ol></details>`;
}
function controls(ui: KanbanPresentation, board: KanbanBoardSummary, item: KanbanItem, actor: KanbanPrincipal | undefined, archived: boolean, interactive = false): string {
    if (archived) return button(ui, 'restore', 'restore');
    if (['completed', 'cancelled'].includes(item.status)) return button(ui, 'archive', 'archiveItem');
    const executable = executableWorkItem(board,item);
    let result = item.status === 'proposed' ? button(ui, 'publish', 'publish') : item.status === 'backlog' && executable ? button(ui, 'ready', 'ready') : item.status === 'open' ? button(ui, 'defer', 'defer') : '';
    if (owns(item, actor) && item.status === 'claimed') result += button(ui, 'renew', 'renew');
    if (item.status === 'review' && !owns(item, actor)) result += interactive ? '' : button(ui, 'accept', 'accept') + button(ui, 'reject', 'reject');
    if (item.blocked) result += button(ui, 'unblock', 'unblock');
    if (item.status === 'review' && owns(item, actor) && board.policy.review !== 'assignee') result += `<p>${escapeHTML(ui.text('noReview'))}</p>`;
    return result;
}
function detailForms(ui: KanbanPresentation, board: KanbanBoardSummary, item: KanbanItem, actor?: KanbanPrincipal): string {
    if (['completed', 'cancelled'].includes(item.status)) return '';
    let forms = '';
    const executable = executableWorkItem(board,item);
    if (!executable && ['backlog', 'proposed', 'open'].includes(item.status)) forms += `<form data-form="close-plan">${field(ui, 'resultRef', 'result')}<button>${escapeHTML(ui.text('closePlan'))}</button></form>`;
    if (!board.automation && executable && item.status === 'open' && !item.blocked) forms += `<form data-form="claim">${board.policy.requireEstimate !== false ? estimates(ui) : ''}<button>${escapeHTML(ui.text('claim'))}</button></form>`;
    if (item.status === 'claimed' && owns(item, actor)) forms += `<form data-form="submit">${field(ui, 'resultRef', 'result')}<button>${escapeHTML(ui.text('submit'))}</button></form>`;
    const automatic = item.eligiblePrincipals?.some(principal => principal.kind === board.automation?.worker.kind && principal.id === board.automation.worker.id);
    let secondary = '';
    if (['proposed', 'backlog', 'open'].includes(item.status) && !automatic && !board.automation) secondary += `<details><summary>${escapeHTML(ui.text('editItem'))}</summary><form data-form="edit-item">${field(ui, 'title', 'name', item.title)}${textarea(ui, 'responsibility', 'responsibility', item.responsibility)}${textarea(ui, 'acceptance', 'acceptance', item.acceptance)}<button>${escapeHTML(ui.text('save'))}</button></form></details>`;
    if (!board.automation && item.launch?.admittedAt === undefined && ['proposed', 'backlog', 'open'].includes(item.status)) secondary += `<details><summary>${escapeHTML(ui.text('plan'))}</summary><form data-form="plan">${planningFields(ui, board, item)}<button>${escapeHTML(ui.text('save'))}</button></form></details><form data-form="cancel">${field(ui, 'reason', 'reason')}<button>${escapeHTML(ui.text('cancel'))}</button></form>`;
    if (owns(item, actor)) secondary += `<form data-form="release">${field(ui, 'reason', 'reason')}<button>${escapeHTML(ui.text('release'))}</button></form>`;
    if (!item.blocked && (!item.owner || owns(item, actor))) secondary += `<form data-form="block">${field(ui, 'reason', 'reason')}<button>${escapeHTML(ui.text('block'))}</button></form>`;
    return forms + `<details><summary>${escapeHTML(ui.text('moreActions'))}</summary>` + secondary + `<form data-form="message">${textarea(ui, 'message', 'message')}<button>${escapeHTML(ui.text('send'))}</button></form></details>`;
}
function estimates(ui: KanbanPresentation): string {
    return `${field(ui, 'complexity', 'complexity', '1', true, 'number')}${field(ui, 'workUnits', 'workUnits', '1', true, 'number')}
        ${field(ui, 'duration', 'duration', '30', true, 'number')}<label>${escapeHTML(ui.text('confidence'))}<select name="confidence">${['low', 'medium', 'high'].map(value => `<option value="${value}">${escapeHTML(ui.text(value))}</option>`).join('')}</select></label>`;
}

export function itemResourceField(ui:KanbanPresentation,catalog:KanbanItemResourceCatalog|undefined,executable:boolean):string {
    if(!catalog||!catalog.resources.length&&!catalog.selected)return '';
    const options=[...catalog.resources],selected=catalog.selected?JSON.stringify(catalog.selected):'';
    if(catalog.selected&&!options.some(option=>option.reference.system===catalog.selected!.system&&option.reference.id===catalog.selected!.id))options.push({reference:catalog.selected,label:catalog.selected.id});
    return `<label>${escapeHTML(ui.text('itemResource'))}<select name="itemResource" data-resource-required="${catalog.required===true}" ${catalog.required&&executable?'required':''} ${catalog.readonly?'disabled':''}>
        <option value="">${escapeHTML(ui.text('none'))}</option>${options.map(option=>`<option value="${escapeAttr(JSON.stringify(option.reference))}" ${JSON.stringify(option.reference)===selected?'selected':''}>${escapeHTML(option.label)}</option>`).join('')}</select>
        ${catalog.readonly?`<input type="hidden" name="itemResource" value="${escapeAttr(selected)}">`:''}</label>`;
}

export function editTaskForm(ui: KanbanPresentation, board: KanbanBoardSummary, item: KanbanItem, editId: string, resources?: KanbanItemResourceCatalog): string {
    return `${panelHeader(ui, item.title, board, item)}<p>${escapeHTML(ui.text('editLeaseHelp'))}</p><form data-form="save-edit"><input type="hidden" name="editId" value="${escapeAttr(editId)}">${field(ui,'title','name',item.title)}${textarea(ui,'responsibility','responsibility',item.responsibility)}${textarea(ui,'acceptance','acceptance',item.acceptance)}${launchModeField(ui,item.launch?.mode)}${planningFields(ui,board,item)}${itemResourceField(ui,resources,true)}${save(ui)}</form>`;
}

function launchModeField(ui: KanbanPresentation, mode = 'automatic'): string {
    return `<label>${escapeHTML(ui.text('taskStartMode'))}<select name="launchMode">${['automatic', 'manual'].map(value => `<option value="${value}" ${mode === value ? 'selected' : ''}>${escapeHTML(ui.text('taskMode.' + value))}</option>`).join('')}</select></label>`;
}
