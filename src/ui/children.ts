import {taskStatus} from './task-state';
import {DEFAULT_KANBAN_WORK_TYPES, type KanbanBoardSummary, type KanbanItem, type KanbanSessionItemPage} from '../contracts';
import type {KanbanPresentation} from './ports';
import {escapeAttr, escapeHTML} from './html';
import {sessionLink} from './session-links';
import {button} from './view';

export function childType(board: KanbanBoardSummary, parent: KanbanItem): string | undefined {
    const types = board.workTypes ?? DEFAULT_KANBAN_WORK_TYPES;
    const rank = types.find(type => type.id === (parent.planning?.kind ?? board.defaultWorkType ?? 'task'))?.rank;
    const candidates = types.filter(type => rank !== undefined && type.rank > rank);
    return (candidates.find(type => type.id === (board.defaultWorkType ?? 'task')) ?? candidates.sort((a, b) => a.rank - b.rank)[0])?.id;
}
export function childrenView(ui: KanbanPresentation, page: KanbanSessionItemPage, cursor: string | undefined, canCreate: boolean, sessionUrl?: (id: string) => string): string {
    return `<h4>${escapeHTML(ui.text('children'))} (${page.total})</h4><div class="kanban__actions">${canCreate ? button(ui, 'new-child', 'newChild') : ''}</div>
        <div class="kanban__record-list">${page.items.map(item => `<article class="kanban__card"><button type="button" data-item="${escapeAttr(item.id)}"><strong>${escapeHTML(item.title)}</strong></button>${taskStatus(ui,item.task)}${item.task?.sessionId?sessionLink(ui,item.task.sessionId,ui.text('executionSession'),sessionUrl?.(item.task.sessionId)):''}${item.execution ? sessionLink(ui, item.execution.resourceId??item.execution.sessionId, ui.text('executionSession'), sessionUrl?.(item.execution.resourceId??item.execution.sessionId)) : ''}</article>`).join('')}</div>
        <div class="kanban__actions">${cursor ? button(ui, 'children-first', 'first') : ''}${page.nextCursor ? `<button type="button" data-action="children-next" data-cursor="${escapeAttr(page.nextCursor)}">${escapeHTML(ui.text('next'))}</button>` : ''}</div>`;
}
