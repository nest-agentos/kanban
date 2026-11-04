import type {KanbanTaskProjection} from '../contracts';
import type {KanbanPresentation} from './ports';
import {escapeHTML, escapeAttr} from './html';

export function taskStatus(ui: KanbanPresentation, task?: KanbanTaskProjection): string {
    if (!task) return '';
    return `<span class="kanban__task-state" data-task-phase="${escapeAttr(task.phase)}">${escapeHTML(ui.text('taskPhase.' + task.phase))}${task.reason ? `<small>${escapeHTML(taskReason(ui, task.reason))}</small>` : ''}${task.phase === 'waiting-start' && task.reason !== 'MANUAL_START_REQUIRED' && task.startAt !== undefined ? `<time data-task-start-at="${task.startAt}" datetime="${new Date(task.startAt).toISOString()}">${escapeHTML(startTimeText(ui,task.startAt))}</time>` : ''}</span>`;
}
export function taskControls(ui: KanbanPresentation, task: KanbanTaskProjection, fixAvailable = false): string {
    return task.actions.filter(action => ['run', 'pause', 'resume', 'edit', 'cancel'].includes(action) || action === 'fix' && fixAvailable).map(action => {
        const label = ui.text('taskAction.' + action), icon = action==='cancel'?ui.icons.close:ui.icons[action as 'run' | 'pause' | 'resume' | 'fix' | 'edit'];
        return `<button type="button" data-action="task-${action}" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}">${icon ?? escapeHTML(label)}</button>`;
    }).join('');
}
export function phaseFilter(ui: KanbanPresentation, selected?: string): string {
    const phases = ['waiting-start','analyzing','queued','waiting-dependency','preparing','running','pausing','paused','resuming','waiting-input','error','review','completed','cancelled','unknown'];
    return `<label>${escapeHTML(ui.text('taskState'))}<select name="phase"><option value="">${escapeHTML(ui.text('all'))}</option>${phases.map(phase => `<option value="${phase}" ${phase === selected ? 'selected' : ''}>${escapeHTML(ui.text('taskPhase.'+phase))}</option>`).join('')}</select></label>`;
}

function startTimeText(ui:KanbanPresentation,startAt:number):string {
    return ui.text('taskStartAt')+' '+new Date(startAt).toLocaleString()+' · '+Math.max(0,Math.ceil((startAt-Date.now())/1000))+'s';
}
export function updateTaskCountdowns(editor:HTMLElement,ui:KanbanPresentation):void {
    for(const node of editor.querySelectorAll<HTMLElement>('[data-task-start-at]')) {
        const at=Number(node.dataset.taskStartAt);if(Number.isFinite(at))node.textContent=startTimeText(ui,at);
    }
}

function taskReason(ui: KanbanPresentation, reason: string): string {
    const key = 'taskReason.' + reason, value = ui.text(key);
    return value === key || value === 'kanban.' + key ? reason : value;
}
