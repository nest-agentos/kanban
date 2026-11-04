import {randomUUID} from '../utils';
import type {KanbanPresentation} from './ports';
import type {KanbanSuggestion, KanbanSuggestionPage, KanbanSuggestionQuery} from '../contracts';
import type {SuggestionField} from './suggestion-field';
export class KanbanSuggestionPicker {
    private input = document.createElement('input');
    private list = document.createElement('div');
    private chips = document.createElement('div');
    private values = document.createElement('div');
    private hint = document.createElement('small');
    private selected: KanbanSuggestion[];
    private rows: KanbanSuggestion[] = [];
    private active = -1;
    private loading = false;
    private generation = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private abort = new AbortController();
    constructor(readonly root: HTMLElement, private readonly config: SuggestionField,
        private readonly fetch: (query: KanbanSuggestionQuery) => Promise<KanbanSuggestionPage>, private readonly presentation: KanbanPresentation) {
        this.selected = [...(config.selected ?? [])]; this.mount(); this.bind(); this.renderValues(); this.close();
    }
    private mount(): void {
        const caption = document.createElement('label'), id = 'kanban-suggest-' + randomUUID();
        caption.textContent = this.presentation.text(this.config.label); caption.htmlFor = this.input.id = id;
        this.input.type = 'text'; this.input.autocomplete = 'off'; this.input.maxLength = 256; this.input.required = !!this.config.required;
        this.input.setAttribute('role', 'combobox'); this.input.setAttribute('aria-autocomplete', 'list'); this.input.setAttribute('aria-controls', this.list.id = id + '-list');
        this.input.setAttribute('aria-describedby', this.hint.id = id + '-hint');
        this.input.placeholder = this.config.free ? this.presentation.text(this.config.label) + ' · ' + this.presentation.text('suggestFreePlaceholder') : this.presentation.text('suggestPlaceholder');
        if (this.config.free) this.input.name = this.config.name;
        this.input.value = this.config.multiple ? '' : this.selected[0]?.label ?? '';
        this.list.className = 'kanban__suggest-list'; this.list.setAttribute('role', 'listbox'); this.list.setAttribute('aria-label', caption.textContent);
        this.chips.className = 'kanban__suggest-chips'; this.hint.setAttribute('aria-live', 'polite');
        this.hint.textContent = this.presentation.text(this.config.free ? 'suggestFreeHint' : 'suggestHint');
        this.root.replaceChildren(caption, this.chips, this.input, this.values, this.list, this.hint);
    }
    private bind(): void {
        const signal = this.abort.signal;
        this.input.addEventListener('focus', () => {if (!this.config.multiple && this.selected.length) this.input.select(); if (!this.loading) void this.search();}, {signal});
        this.input.addEventListener('click', () => {if (this.list.hidden && !this.loading) void this.search();}, {signal});
        this.input.addEventListener('input', () => {
            if (!this.config.multiple && !this.config.free) {this.selected = []; this.renderValues();}
            this.validate(); clearTimeout(this.timer); this.generation++;
            this.rows = []; this.active = -1; this.list.replaceChildren(); this.hint.textContent = this.presentation.text('loading'); this.open();
            this.timer = setTimeout(() => {void this.search();}, 150);
        }, {signal});
        this.input.addEventListener('keydown', event => this.keydown(event), {signal});
        this.list.addEventListener('pointerdown', event => event.preventDefault(), {signal});
        this.root.addEventListener('click', event => this.click(event), {signal});
        document.addEventListener('scroll', () => this.position(), {signal, capture: true});
        window.addEventListener('resize', () => this.position(), {signal});
        this.root.addEventListener('focusout', event => {if (!this.root.contains(event.relatedTarget as Node | null)) this.close();}, {signal});
    }
    private async search(): Promise<void> {
        const generation = ++this.generation, operationId = randomUUID(), started = Date.now();
        const search = !this.config.multiple && this.selected[0]?.label === this.input.value ? '' : this.input.value.trim();
        const kind = this.root.closest('form')?.querySelector<HTMLSelectElement>('[name=kind]')?.value;
        this.revealInput(); this.loading = true; this.hint.textContent = this.presentation.text('loading');
        try {
            const page = await this.fetch({kind: this.config.kind, search, limit: 12, ...(this.config.multiple ? {excludeIds: this.selected.map(row => row.id)} : {}), ...(this.config.excludeItemId ? {excludeItemId: this.config.excludeItemId} : {}),
                ...(this.config.kind === 'parent' && kind ? {childKind: kind} : {})});
            if (generation !== this.generation || this.abort.signal.aborted || !this.root.isConnected) return;
            this.rows = page.items.filter(row => !this.config.multiple || !this.selected.some(value => value.id === row.id));
            if (this.config.manual && search && !this.rows.some(row => row.id === search)) this.rows.push({id: search, label: search, detail: this.presentation.text('suggestManualId')});
            this.active = this.rows.length ? 0 : -1; this.renderOptions();
            this.hint.textContent = this.presentation.text(page.hasMore ? 'suggestRefine' : this.rows.length ? this.config.free ? 'suggestFreeHint' : 'suggestHint' : 'suggestEmpty');
            this.log( {operationId, stage: this.config.kind, result: 'success', count: page.items.length, durationMs: Date.now() - started});
        } catch (error) {
            if (generation !== this.generation || this.abort.signal.aborted) return;
            this.rows = []; this.list.replaceChildren(); this.hint.textContent = this.presentation.text('suggestFailed');
            const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = this.presentation.text('retry'); retry.dataset.suggestRetry = '';
            this.list.append(retry); this.open();
            const raw = (error as {code?: unknown})?.code, code = typeof raw === 'string' && /^[A-Z_0-9]{1,80}$/.test(raw) ? raw : 'KANBAN_SUGGEST_FAILED';
            this.log( {operationId, stage: this.config.kind, result: 'failure', code, durationMs: Date.now() - started});
        } finally {if (generation === this.generation) this.loading = false;}
    }
    private log(event: Parameters<NonNullable<KanbanPresentation['log']>>[0]): void {
        try {this.presentation.log?.(event);} catch { /* Diagnostics cannot change selection state. */ }
    }
    private renderOptions(): void {
        this.list.replaceChildren();
        this.rows.forEach((row, index) => {
            const button = document.createElement('button'); button.type = 'button'; button.tabIndex = -1; button.dataset.suggestIndex = String(index);
            button.id = this.list.id + '-' + index; button.setAttribute('role', 'option');
            const title = document.createElement('strong'), detail = document.createElement('small'); title.textContent = row.label;
            detail.textContent = [row.status ? this.presentation.text(row.status) : '', row.archived ? this.presentation.text('archive') : '', row.detail, this.config.free ? '' : row.id].filter(Boolean).join(' · ');
            button.append(title, detail); this.list.append(button);
        });
        this.open(); this.markActive();
    }
    private click(event: Event): void {
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!button) return;
        if (button.dataset.suggestIndex !== undefined) this.choose(this.rows[Number(button.dataset.suggestIndex)]);
        else if (button.dataset.suggestRemove !== undefined) {this.selected = this.selected.filter(row => row.id !== button.dataset.suggestRemove); this.renderValues(); this.changed(); this.input.focus();}
        else if (button.hasAttribute('data-suggest-retry')) {void this.search(); this.input.focus();}
    }
    private choose(row: KanbanSuggestion | undefined): void {
        if (!row) return;
        this.selected = this.config.multiple ? [...this.selected, row] : [row]; this.input.value = this.config.multiple ? '' : row.label;
        this.renderValues(); this.input.setCustomValidity(''); this.hint.textContent = this.presentation.text(this.config.free ? 'suggestFreeHint' : 'suggestHint'); this.changed(); this.close(); this.input.focus();
    }
    private renderValues(): void {
        this.values.replaceChildren(); this.chips.replaceChildren();
        if (!this.config.free) for (const row of this.selected.length ? this.selected : this.config.multiple ? [] : [{id: '', label: ''}]) {
            const input = document.createElement('input'); input.type = 'hidden'; input.name = this.config.name; input.value = row.id; this.values.append(input);
        }
        if (this.config.multiple) for (const row of this.selected) {
            const chip = document.createElement('button'); chip.type = 'button'; chip.dataset.suggestRemove = row.id;
            const name = document.createElement('span'), remove = document.createElement('span'); name.textContent = row.label; remove.innerHTML = this.presentation.icons.close; remove.setAttribute('aria-hidden', 'true'); chip.append(name, remove); chip.setAttribute('aria-label', this.presentation.text('suggestRemove') + ': ' + row.label); this.chips.append(chip);
        }
    }
    private validate(): void {
        const unselected = !this.config.free && !!this.input.value.trim() && (this.config.multiple || !this.selected.length);
        this.input.setCustomValidity(unselected ? this.presentation.text('suggestPickRequired') : '');
    }
    private changed(): void {this.validate(); this.root.dispatchEvent(new Event('input', {bubbles: true}));}
    private keydown(event: KeyboardEvent): void {
        if (event.key === 'Escape' && !this.list.hidden) {event.preventDefault(); event.stopPropagation(); this.close(); return;}
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); event.stopPropagation();
            if (this.list.hidden) {void this.search(); return;}
            this.active = this.rows.length ? (this.active + (event.key === 'ArrowDown' ? 1 : -1) + this.rows.length) % this.rows.length : -1; this.markActive();
        } else if (event.key === 'Enter' && !this.list.hidden) {event.preventDefault(); event.stopPropagation(); this.choose(this.rows[this.active]);}
        else if (event.key === 'Tab' && !this.list.querySelector('[data-suggest-retry]')) this.close();
        else if (event.key === 'Backspace' && this.config.multiple && !this.input.value && this.selected.length) {this.selected.pop(); this.renderValues(); this.changed();}
    }
    private markActive(): void {
        [...this.list.children].forEach((node, index) => node.setAttribute('aria-selected', String(index === this.active)));
        if (this.active >= 0) {this.input.setAttribute('aria-activedescendant', this.list.id + '-' + this.active); const row = this.list.children[this.active] as HTMLElement | undefined;
            if (row && row.offsetTop < this.list.scrollTop) this.list.scrollTop = row.offsetTop;
            else if (row && row.offsetTop + row.offsetHeight > this.list.scrollTop + this.list.clientHeight) this.list.scrollTop = row.offsetTop + row.offsetHeight - this.list.clientHeight;}
        else this.input.removeAttribute('aria-activedescendant');
    }
    private open(): void {this.list.hidden = false; this.input.setAttribute('aria-expanded', 'true'); this.position();}
    private revealInput(): void {
        const panel = this.root.closest<HTMLElement>('[data-panel]'); if (!panel) return;
        const input = this.input.getBoundingClientRect(), bounds = panel.getBoundingClientRect();
        const top = (panel.querySelector('.kanban__panel-header')?.getBoundingClientRect().bottom ?? bounds.top) + 8, bottom = bounds.bottom - 12;
        if (input.bottom > bottom) panel.scrollTop += input.bottom - bottom;
        else if (input.top < top) panel.scrollTop -= top - input.top;
    }
    private position(): void {
        if (this.list.hidden || !this.root.isConnected) return;
        const input = this.input.getBoundingClientRect(), scope = (this.root.closest('[data-panel]') ?? this.root.closest('.kanban') ?? document.documentElement).getBoundingClientRect();
        const below = Math.max(0, scope.bottom - input.bottom - 8), above = Math.max(0, input.top - scope.top - 8), up = above > below && below < 160;
        const height = Math.min(210, up ? above : below), width = Math.min(Math.max(input.width, 220), Math.max(0, scope.width - 16));
        const left = Math.max(scope.left + 8, Math.min(input.left, scope.right - width - 8));
        Object.assign(this.list.style, {position: 'fixed', zIndex: '30', left: `${left}px`, width: `${width}px`, maxHeight: `${height}px`,
            top: up ? 'auto' : `${input.bottom + 4}px`, bottom: up ? `${innerHeight - input.top + 4}px` : 'auto'});
    }
    private close(): void {this.loading = false; if (this.hint.textContent === this.presentation.text('loading')) this.hint.textContent = this.presentation.text(this.config.free ? 'suggestFreeHint' : 'suggestHint'); clearTimeout(this.timer); this.generation++; this.list.hidden = true; this.input.setAttribute('aria-expanded', 'false'); this.input.removeAttribute('aria-activedescendant');}
    destroy(): void {clearTimeout(this.timer); this.generation++; this.abort.abort();}
}
