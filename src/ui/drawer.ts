import {escapeAttr} from './html';
import type {KanbanPresentation} from './ports';

/** A bounded modal inspector preserves the board's independent scroll positions. */
export class KanbanDrawer {
    private key = '';
    private focusRequested = false;
    private restoreTarget?: HTMLElement;
    private restoreItem?: string;
    private restoreRecord?: string;
    private restoreRequested = false;
    constructor(private readonly editor: HTMLElement, private readonly sidebar?: HTMLElement) {}
    get element(): HTMLElement {return this.editor.querySelector('[data-panel]')!;}
    get open(): boolean {return !this.element.hidden;}
    show(html: string, key: string): void {
        const panel = this.element, same = this.open && this.key === key, top = same ? panel.scrollTop : 0;
        if (!this.open) {
            const active = document.activeElement as HTMLElement | null;
            this.restoreTarget = active ?? undefined; this.restoreItem = active?.dataset.item; this.restoreRecord = active?.dataset.record;
        }
        this.focusRequested ||= same && panel.contains(document.activeElement);
        const retained = same ? ['[data-work-resource-section]', '[data-related-sessions-section]'].map(selector => ({selector, node: panel.querySelector(selector)})) : [];
        panel.innerHTML = html;
        for (const {selector, node} of retained) if (node?.hasChildNodes()) panel.querySelector(selector)?.replaceWith(node);
        const error = document.createElement('p'); error.dataset.panelError = ''; error.setAttribute('role', 'alert');
        const header = panel.querySelector('.kanban__panel-header'); if (header) header.after(error); else panel.prepend(error);
        panel.hidden = false; panel.scrollTop = top;
        this.key = key; this.focusRequested ||= !same;
        this.editor.querySelector<HTMLElement>('[data-content]')!.inert = true; if (this.sidebar) this.sidebar.inert = true;
        this.editor.querySelector<HTMLElement>('[data-backdrop]')!.hidden = false;
        this.editor.classList.add('kanban--detail');
    }
    close(): void {
        this.element.hidden = true; this.element.replaceChildren(); this.key = ''; this.focusRequested = false; this.restoreRequested = true;
        this.editor.querySelector<HTMLElement>('[data-content]')!.inert = false; if (this.sidebar) this.sidebar.inert = false;
        this.editor.querySelector<HTMLElement>('[data-backdrop]')!.hidden = true; this.editor.classList.remove('kanban--detail');
    }
    flushFocus(): void {
        if (this.focusRequested && this.open) {this.focusRequested = false; this.element.focus({preventScroll: true});}
        else if (this.restoreRequested) {
            this.restoreRequested = false;
            const matches = [...this.editor.querySelectorAll<HTMLElement>('[data-item], [data-record]')];
            const target = this.restoreTarget?.isConnected ? this.restoreTarget : matches.find(node =>
                this.restoreItem ? node.dataset.item === this.restoreItem : this.restoreRecord ? node.dataset.record === this.restoreRecord : false);
            (target ?? this.editor.querySelector<HTMLElement>('button'))?.focus({preventScroll: true});
        }
    }
    keydown(event: KeyboardEvent): void {
        if (!this.open || event.key !== 'Tab') return;
        const nodes = [...this.element.querySelectorAll<HTMLElement>('button, input:not([type=hidden]), select, textarea, a[href], summary, [tabindex="0"]')]
            .filter(node => !node.matches(':disabled') && node.tabIndex >= 0 && !node.closest('[hidden], [inert]') && !node.hidden && !node.closest('details:not([open]) :not(summary)'));
        const first = nodes[0], last = nodes[nodes.length - 1], active = document.activeElement;
        if (!first) {event.preventDefault(); this.element.focus(); return;}
        if (event.shiftKey && (active === first || active === this.element)) {event.preventDefault(); last.focus();}
        else if (!event.shiftKey && (active === last || !this.element.contains(active))) {event.preventDefault(); first.focus();}
    }
    destroy(): void {if (this.sidebar) this.sidebar.inert = false; this.editor.classList.remove('kanban--detail');}
}
export function drawerMarkup(ui: KanbanPresentation): string {
    return `<button type="button" class="kanban__backdrop" data-backdrop data-action="dismiss-panel" aria-label="${escapeAttr(ui.text('closeDetail'))}" tabindex="-1" hidden></button>
        <section data-panel class="kanban__panel" role="dialog" aria-modal="true" aria-label="${escapeAttr(ui.text('details'))}" tabindex="-1" hidden></section>`;
}
export function preserveBoardScroll(container: HTMLElement, render: () => void): void {
    const columns = [...container.querySelectorAll<HTMLElement>('[data-column]')].map(node => ({id: node.dataset.column, top: node.scrollTop}));
    const left = container.querySelector<HTMLElement>('.kanban__columns')?.scrollLeft ?? 0;
    render();
    for (const node of container.querySelectorAll<HTMLElement>('[data-column]')) node.scrollTop = columns.find(column => column.id === node.dataset.column)?.top ?? 0;
    const board = container.querySelector<HTMLElement>('.kanban__columns'); if (board) board.scrollLeft = left;
}
