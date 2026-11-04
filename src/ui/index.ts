import {updateTaskCountdowns} from './task-state';
import {projectKanbanTask} from '../contracts/task-projection';
import {editTaskForm} from './forms';
import {automationForm, analysisView, preparationFields} from './automation';
import {KanbanSuggestions} from './suggestions';
import {mountTitleBar as mountSharedTitleBar} from '@nestos/ui-common';
import {KanbanDrawer, drawerMarkup, preserveBoardScroll} from './drawer';
import {escapeHTML} from './html';
import {childrenView, childType} from './children';
import {linkPair} from './session-links';
import {failureDetails} from './diagnostics';
import {itemOperationsView} from './operations';
import type {KanbanItemOperations} from '../contracts';
import {workResourcesView} from './work-resources';
import {relatedSessionsView} from './session-view';
import {randomUUID} from '../utils';
import type {KanbanUIOptions} from './ports';
import {createRenderer} from './renderer';
import type {KanbanBoardSummary, KanbanCommand, KanbanItem, KanbanSessionItemPage, KanbanSessionActivityQuery, KanbanPrincipal, KanbanRequest} from '../contracts';
import {actionCommand, boardInput, formCommand, value} from './commands';

export class KanbanWorkbench {
    private board?: KanbanBoardSummary;
    private page?: KanbanSessionItemPage;
    private actor?: KanbanPrincipal;
    private automationCatalog?: import('../contracts').KanbanAutomationCatalog;
    private item?: KanbanItem;
    private editing?: {itemId:string; editId:string};
    private itemArchived = false;
    private operations?: KanbanItemOperations;
    private boardId = '';
    private recordKind?: 'log' | 'decision';
    private recordId = '';
    private recordPage?: import('../contracts').KanbanRecordPage;
    private recordCursor?: string;
    private suggestions!: KanbanSuggestions;
    private drawer!: KanbanDrawer;
    private itemId = '';
    private query: KanbanSessionActivityQuery = {view: 'all', limit: 50};
    private activityTimer?: ReturnType<typeof setInterval>;
    private generation = 0;
    private eventGeneration = 0;
    private abort = new AbortController();
    private busy = false;
    private background?: Promise<void>;
    private operationStage = 'ui.operation';
    private dirty = false;
    private visible = true;
    private invalid = false;
    private pending?: {boardId: string; fingerprint: string; request: KanbanRequest};
    private readonly ui;
    private releaseNavigation?: () => void;
    private readonly windowMounts = new Map<HTMLElement, () => void>();
    constructor(private readonly options: KanbanUIOptions, private readonly container?: HTMLElement) {this.ui = createRenderer(options.presentation);}
    async start(): Promise<void> {
        const {sidebar, editor} = this.options, signal = this.abort.signal;
        sidebar?.classList.add('kanban__sidebar'); editor.classList.add('kanban');
        editor.innerHTML = `<p data-status role="status"></p><p data-error role="alert"></p><div data-retry hidden>${this.ui.button('refresh', 'retry')}</div><div data-content class="kanban__content"></div>${drawerMarkup(this.options.presentation)}`;
        this.drawer = new KanbanDrawer(editor, sidebar);
        this.suggestions = new KanbanSuggestions(editor, this.options.service, () => this.boardId, this.options.presentation);
        document.addEventListener('pointerdown', event => {
            for (const menu of editor.querySelectorAll<HTMLDetailsElement>('[data-popover][open]')) if (!menu.contains(event.target as Node)) menu.open = false;
        }, {signal});
        editor.addEventListener('toggle', event => {
            const opened = event.target;
            if (opened instanceof HTMLDetailsElement && opened.open && opened.hasAttribute('data-related-sessions')) {void this.loadRelatedSessions(); return;}
            if (opened instanceof HTMLDetailsElement && opened.open && opened.hasAttribute('data-work-resources')) {void this.loadWorkResources(); return;}
            if (!(opened instanceof HTMLDetailsElement) || !opened.open || !opened.hasAttribute('data-popover')) return;
            for (const menu of editor.querySelectorAll<HTMLDetailsElement>('[data-popover][open]')) if (menu !== opened) menu.open = false;
        }, {capture: true, signal});
        editor.addEventListener('change',event=>{
            const target=event.target;if(!(target instanceof HTMLSelectElement)||target.name!=='kind')return;
            const resource=target.closest('form')?.querySelector<HTMLSelectElement>('select[name="itemResource"]');
            if(resource)resource.required=resource.dataset.resourceRequired==='true'&&target.selectedOptions[0]?.dataset.executable==='true';
        },{signal});
        editor.addEventListener('keydown', event => {
            const menu = editor.querySelector<HTMLDetailsElement>('[data-popover][open]');
            if (event.key === 'Escape' && menu) {event.preventDefault(); event.stopPropagation(); menu.open = false; menu.querySelector<HTMLElement>('summary')?.focus(); return;}

            this.drawer.keydown(event);
            if (event.key === 'Escape' && this.drawer.open) {event.preventDefault(); void this.run(() => this.requestClose(false));}
        }, {signal});
        for (const element of sidebar ? [sidebar, editor] : [editor]) element.addEventListener('click', event => {
            if (event instanceof MouseEvent && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0)) return;
            if (!(event.target as HTMLElement).closest('[data-action], [data-board], [data-item], [data-session], [data-record], [data-context]')) return;
            void this.run(async () => {
                await this.click(event);
                if (element === sidebar) this.options.activated?.();
            });
        }, {signal});
        sidebar?.addEventListener('submit', event => {event.preventDefault(); void this.run(() => this.submit(event));}, {signal});
        editor.addEventListener('submit', event => {event.preventDefault(); void this.run(() => this.submit(event));}, {signal});
        editor.addEventListener('change', event => {
            const target = event.target as HTMLSelectElement;
            if (target.name === 'preparation' && this.board && this.automationCatalog) {
                const container = editor.querySelector('[data-preparation-options]');
                if (container) container.innerHTML = preparationFields(this.board, this.automationCatalog, target.value ? JSON.parse(target.value) : null);
            }
        }, {signal});
        editor.addEventListener('input', event => {
            const target = event.target as HTMLElement;
            if (target.closest('[data-form=reference]')) return;
            if (target.closest('form')) this.generation++;
            if (target.closest('[data-panel]')) {this.dirty = true; this.options.changed?.();}
        }, {signal});
        this.activityTimer = setInterval(() => {
            if (!this.visible || document.hidden) return;
            updateTaskCountdowns(this.options.editor, this.options.presentation);
            if (this.options.service?.queryActivity && (this.board?.automation?.enabled || this.page?.items.some(item => item.execution)
                || this.query.execution && this.query.execution !== 'all')) this.refreshInBackground(true);
        }, 15000);
        if (this.options.initialResource !== undefined) await this.openResource(this.options.initialResource);
        else await this.run(() => this.refresh());
    }
    open(target: {boardId?: string; itemId?: string; recordId?: string}): Promise<void> {
        const path = target.boardId ? `/board/${encodeURIComponent(target.boardId)}${target.recordId ? '/@record/' + encodeURIComponent(target.recordId) : target.itemId ? '/' + encodeURIComponent(target.itemId) : ''}` : '/';
        return this.openResource(path);
    }
    dispose(): Promise<void> {return this.destroy();}
    async openResource(path: string): Promise<void> {
        if (this.busy || this.dirty) throw new Error(this.ui.label('unsaved'));
        this.closePanel();
        const parts = path.split('/'); this.boardId = decodeURIComponent(parts[2] ?? ''); this.itemId = decodeURIComponent(parts[3] ?? '');
        this.recordId = parts[3] === '@record' ? decodeURIComponent(parts[4] ?? '') : '';
        if (this.recordId) this.itemId = '';
        this.recordKind = ['@log', '@decision'].includes(parts[3] ?? '') ? parts[3].slice(1) as 'log' | 'decision' : undefined;
        if (this.recordKind) this.itemId = '';
        this.recordCursor = undefined;
        this.query = {view: 'all', limit: 50}; await this.run(() => this.refresh());
    }
    createBoard(): Promise<void> {return this.run(async () => {
        if (this.dirty) throw new Error(this.ui.label('unsaved'));
        this.showBoardForm();
    });}
    private showBoardForm(): void {this.itemId = ''; this.drawer.show(this.ui.newBoardForm(), 'new-board'); this.dirty = true;}
    getActiveResourceId(): string {return this.boardId ? `/board/${encodeURIComponent(this.boardId)}${this.recordId ? '/@record/' + encodeURIComponent(this.recordId) : this.itemId ? '/' + encodeURIComponent(this.itemId) : this.recordKind ? '/@' + this.recordKind : ''}` : '/';}
    getViewState() {
        return {title: this.drawer?.open ? this.panel().querySelector('h3')?.textContent ?? this.board?.title : this.board?.title ?? this.ui.label('title'),
            context: this.board?.title, dirty: this.dirty, busy: this.busy};
    }
    captureRecovery(): unknown {if (this.busy || this.dirty) throw new Error(this.ui.label('unsaved')); return null;}
    restoreRecovery(): void {}
    suspendForRecovery(): void {this.generation++; this.abort.abort(); this.suggestions?.destroy();if(this.activityTimer) clearInterval(this.activityTimer);}
    async destroy(): Promise<void> {
        for (const release of this.windowMounts.values()) release(); this.windowMounts.clear();
        this.suspendForRecovery(); this.releaseNavigation?.(); this.releaseNavigation = undefined; this.suggestions?.destroy(); this.drawer?.destroy(); this.options.sidebar?.replaceChildren(); this.options.editor.replaceChildren(); this.options.editor.inert = false;
        this.options.editor.classList.remove('kanban'); this.options.sidebar?.classList.remove('kanban__sidebar');
        this.container?.replaceChildren(); this.container?.classList.remove('kanban-layout');
    }
    invalidateFromEvents(): void {
        this.invalid = true; this.eventGeneration++;
        this.refreshInBackground();
    }
    setVisible(visible: boolean): void {this.visible = visible; if (visible && this.invalid) this.invalidateFromEvents();}
    private refreshInBackground(activityOnly = false): void {
        if (this.background || this.busy || this.dirty || !this.visible || this.abort.signal.aborted) return;
        if (document.activeElement?.closest('form') && this.options.editor.contains(document.activeElement)) return;
        const started = Date.now(), operationId = randomUUID();
        const reading = activityOnly ? this.refreshActivity(this.generation) : this.refresh(), generation = this.generation;
        this.background = reading.catch(error => {
            if (!this.alive(generation)) return;
            this.invalid = false;
            if (!this.abort.signal.aborted) {this.reportRead('ui.background', error, operationId, started); this.error(errorText(error, this.ui.label, 'ui.background'));}
        }).finally(() => {
            this.background = undefined;
            if (this.invalid && !this.busy && !this.dirty && this.visible && !this.abort.signal.aborted) this.refreshInBackground();
        });
    }
    private queryPage(): Promise<KanbanSessionItemPage> {
        const service = this.options.service!;
        return this.query.execution && this.query.execution !== 'all' && service.queryActivity
            ? service.queryActivity(this.boardId, this.query) : service.query(this.boardId, this.query);
    }
    private async refreshActivity(generation: number): Promise<void> {
        if (this.item && this.itemId) {await Promise.all([this.loadExecutionSections(generation, this.item, this.itemArchived), this.operations?.operations.some(operation => ["running", "unknown"].includes(operation.state)) ? this.loadOperations(generation) : undefined]); return;}
        if (!this.board || this.recordId || this.recordKind || !this.options.service?.queryActivity) return;
        await this.supplement('ui.activity', generation, () => this.options.service!.queryActivity!(this.boardId, this.query), page => {
            if (page.revision !== this.page?.revision) {this.invalid = true; this.refreshInBackground(); return;}
            if (JSON.stringify(page) === JSON.stringify(this.page)) return;
            const sameItems = page.total === this.page.total && page.nextCursor === this.page.nextCursor
                && JSON.stringify(page.items.map(item => item.id)) === JSON.stringify(this.page.items.map(item => item.id));
            this.page = page;
            if (sameItems) {
                const sessions = new Map(page.items.map(item => [item.id, item.execution]));
                for (const slot of this.content().querySelectorAll<HTMLElement>('[data-item-execution]')) {
                    const html = this.ui.executionBadge(sessions.get(slot.dataset.itemExecution!), this.options.sessionUrl);
                    if (slot.innerHTML !== html) slot.innerHTML = html;
                }
                return;
            }
            preserveBoardScroll(this.content(), () => {this.content().innerHTML = this.ui.boardView(this.board!, page, this.query, true, !!this.options.service?.automationCatalog, this.options.sessionUrl);});
            this.mountHeaderActions();
        });
    }
    private async refresh(): Promise<void> {
        const service = this.options.service, generation = ++this.generation, events = this.eventGeneration;
        if (!service) {this.content().innerHTML = `<p>${escapeHTML(this.ui.label('unavailable'))}</p>`; return;}
        this.operationStage = 'ui.snapshot';
        const pageRequest = this.boardId ? this.queryPage() : undefined;
        const itemRequest = this.boardId && this.itemId ? service.item(this.boardId, this.itemId) : undefined;
        const [boards, actor, initialPage, initialItem] = await Promise.all([service.catalog?.() ?? service.list(), service.currentPrincipal(), pageRequest, itemRequest]);
        if (!this.alive(generation)) return;
        this.actor = actor;
        if (!this.boardId && this.options.initialResource === undefined) this.boardId = boards[0]?.id ?? '';
        this.board = boards.find(board => board.id === this.boardId);
        if (this.boardId && !this.board) throw Object.assign(new Error('Board unavailable'), {code: 'BOARD_NOT_FOUND'});
        if(this.query.execution&&this.query.execution!=='all'&&!service.queryActivity) throw Object.assign(new Error('Execution Session projection unavailable'),{code:'EXECUTION_SESSION_UNAVAILABLE'});
        const page = this.board ? initialPage ?? await this.queryPage() : undefined;
        if (!this.alive(generation)) return;
        this.page = page; this.invalid = events !== this.eventGeneration;
        if (this.options.sidebar) this.options.sidebar.innerHTML = this.ui.navigation(boards, this.boardId);
        this.operationStage = 'ui.render';
        preserveBoardScroll(this.content(), () => {this.content().innerHTML = this.board && page ? this.ui.boardView(this.board, page, this.query, !!service.queryActivity, !!service.automationCatalog, this.options.sessionUrl) : this.ui.catalogView(boards);});
        if (this.recordKind) await this.showRecords(generation);
        if (!this.alive(generation)) return;
        this.releaseNavigation?.(); this.releaseNavigation = undefined;
        const navigation = this.content().querySelector<HTMLElement>('[data-navigation]');
        if (navigation && !this.options.mountTitleBar) this.releaseNavigation = this.options.mountNavigation?.(navigation);
        if (this.recordId) await this.showRecord(this.recordId, generation);
        else if (this.itemId) await this.showItem(generation, initialItem);
        else if (!this.recordKind) void this.refreshActivity(generation);
        this.mountHeaderActions();
        this.operationStage = 'ui.selection'; this.options.selected(this.getActiveResourceId());
    }
    private async showItem(generation = this.generation, loaded?: Awaited<ReturnType<NonNullable<KanbanUIOptions['service']>['item']>>): Promise<void> {
        const service = this.options.service;
        if (!service || !this.board || !this.itemId) return;
        this.operationStage='ui.item.load';
        const {item, archive, task} = loaded ?? await service.item(this.boardId, this.itemId);
        if (!this.alive(generation)) return;
        this.operationStage='ui.item.render';
        const referencesChanged = this.item?.id === item.id && JSON.stringify(this.item.externalRefs) !== JSON.stringify(item.externalRefs);
        if (!this.drawer.open || this.itemArchived !== !!archive || JSON.stringify(this.item) !== JSON.stringify(item)) this.drawer.show(this.ui.detailView(this.board, item, this.actor, !!archive, [], !!service.executionSession, this.options.reviewGuidance?.(this.board, item), !!service.itemOperations && !archive && (this.options.itemOperationsAvailable?.(this.board, item) ?? true), task ?? projectKanbanTask(item), !!service.fixTask), 'item:' + item.id);
        this.item = item; this.itemArchived = !!archive;
        this.loadItemSections(generation, item, !!archive);
        const resources = this.panel().querySelector<HTMLDetailsElement>('[data-work-resources]');
        if (referencesChanged && resources) {
            resources.dataset.associationRevision = String(Number(resources.dataset.associationRevision ?? 0) + 1);
            delete resources.dataset.loaded; if (resources.open) void this.loadWorkResources(false, true);
        }
        this.options.selected(this.getActiveResourceId());
    }
    private loadItemSections(generation: number, item: KanbanItem, archived: boolean): void {
        const service = this.options.service!, boardId = this.boardId;
        if (service.executionSession && !this.panel().querySelector('[data-related-sessions]'))
            this.setSection('[data-related-sessions-section]', `<details data-related-sessions><summary>${escapeHTML(this.ui.label('relatedSessions'))}</summary><button type="button" data-action="refresh-related-sessions">${escapeHTML(this.ui.label('refresh'))}</button><div data-related-sessions-body></div></details>`);
        if (service.workResources) {
            const resources = this.panel().querySelector<HTMLDetailsElement>('[data-work-resources]');
            if (!resources) this.setSection('[data-work-resource-section]', `<details data-work-resources><summary>${escapeHTML(this.ui.label('workResourceTitle'))}</summary><p>${escapeHTML(this.ui.label('workResourceHelp'))}</p><div class="kanban__actions"><button type="button" data-action="refresh-work-resources">${escapeHTML(this.ui.label('refresh'))}</button><button type="button" data-action="inspect-work-resources">${escapeHTML(this.ui.label('inspectWorkResources'))}</button></div><div data-work-resource-body></div></details>`);
        }
        void this.supplement('ui.item.events', generation, () => service.events(boardId, 0, 200), events => {
            this.setSection('[data-item-events]', this.ui.itemEventsView(events.filter(event => event.itemId === item.id).reverse()));
        }, '[data-item-events]');
        void this.supplement('ui.item.records', generation, () => service.records(boardId, {itemId: item.id, limit: 10}), records => {
            this.setSection('[data-related-records]', `<h4>${escapeHTML(this.ui.label('relatedRecords'))} (${records.total})</h4>${this.ui.recordLinks(records, this.board!)}<div class="kanban__actions">${this.ui.button('new-log', 'newLog')}${this.ui.button('new-decision', 'newDecision')}</div>`);
        }, '[data-related-records]');
        void this.loadOperations(generation);
        void this.loadExecutionSections(generation, item, archived, true);
        if (!service.executionSession) this.loadReferenceSection(generation, item);
        void this.supplement('ui.item.children', generation, () => this.showChildren(generation), () => {}, '[data-children]');
    }
    private async loadExecutionSections(generation: number, item: KanbanItem, archived: boolean, references = false): Promise<void> {
        const service = this.options.service!, boardId = this.boardId, reads: Promise<void>[] = [];
        if (service.executionSession) reads.push(this.supplement('ui.item.session', generation, () => service.executionSession!(boardId, item.id), execution => {
            this.setSection('[data-execution-session]', this.ui.executionSessionView(execution, !!this.options.executionReference && !archived && !['completed', 'cancelled'].includes(item.status) && item.launch?.admittedAt === undefined, this.options.sessionUrl));
            if (references) this.loadReferenceSection(generation, item, new Set(execution.history.map(binding => binding.sessionId)));
        }, '[data-execution-session]'));
        if (this.board?.automation && service.analysisStatus) reads.push(this.supplement('ui.item.analysis', generation, () => service.analysisStatus!(boardId, item.id), analysis => {
            this.setSection('[data-analysis]', analysisView(this.options.presentation, analysis ?? null));
        }, '[data-analysis]'));
        await Promise.all(reads);
    }
    private async loadOperations(generation: number): Promise<void> {
        const service = this.options.service, item = this.item;
        if (!service?.itemOperations || !item || !this.panel().querySelector('[data-item-operations]')) return;
        await this.supplement('ui.item.operations', generation, () => service.itemOperations!(this.boardId, item.id), view => {
            this.operations = view;
            this.setSection('[data-item-operations]', itemOperationsView(this.options.presentation, view, this.options.sessionUrl));
        }, '[data-item-operations]');
    }
    private async submitOperation(form: HTMLFormElement, data: FormData, binding: boolean): Promise<void> {
        const service = this.options.service!, action = form.dataset.operation!, itemId = this.item!.id;
        const request = {operationId: form.dataset.resourceId!, itemId, action, expectedRevision: form.dataset.revision!};
        const entry = this.operations?.operations.find(operation => operation.id === action);
        this.operationStage = binding ? 'ui.operation.bind' : 'ui.operation.start';
        const view = binding ? await service.bindItemOperation!(this.boardId, {...request, target: JSON.parse(value(data, 'target'))})
            : await service.runItemOperation!(this.boardId, {...request, confirmed: data.has('confirmed'),
                selections: Object.fromEntries((entry?.fields ?? []).map(field => [field.id, value(data, 'choice-' + field.id)]))});
        this.dirty = false; this.operations = view; this.options.committed?.();
        this.setSection('[data-item-operations]', itemOperationsView(this.options.presentation, view, this.options.sessionUrl));
        this.options.changed?.();
        const result = view.operations.find(operation => operation.id === action);
        if (!binding && result?.state === 'succeeded') await this.refresh();
        if (!binding && entry?.openSessionOnRun && result?.sessionId) await this.options.openSession(result.sessionId);
    }
    private loadReferenceSection(generation: number, item: KanbanItem, skip?: Set<string>): void {
        void this.supplement('ui.item.references', generation, () => this.showReferenceLinks(item.externalRefs ?? [], generation, skip), () => {}, '[data-reference-links]');
    }
    private async supplement<T>(stage: string, generation: number, read: () => Promise<T>, apply: (value: T) => void, selector?: string): Promise<void> {
        const started = Date.now(), operationId = randomUUID();
        try {
            const value = await read();
            if (!this.alive(generation) || this.dirty) return;
            apply(value);
            try {this.options.presentation.log?.({operationId, stage, result: 'success', durationMs: Date.now() - started});} catch { /* Diagnostics cannot change a read result. */ }
        } catch (error) {
            if (!this.alive(generation)) return;
            this.reportRead(stage, error, operationId, started);
            const slot = selector ? this.panel().querySelector(selector) : undefined;
            if (slot) {
                const notice = slot.querySelector('[data-read-error]') ?? document.createElement('p'); notice.setAttribute('role', 'alert'); notice.setAttribute('data-read-error', '');
                notice.textContent = errorText(error, this.ui.label, stage); if (!notice.parentElement) slot.append(notice);
            }
            else this.error(errorText(error, this.ui.label, stage));
        }
    }
    private setSection(selector: string, html: string): void {
        const slot = this.panel().querySelector(selector);
        if (slot && slot.innerHTML !== html) slot.innerHTML = html;
    }
    private reportRead(stage: string, error: unknown, operationId = randomUUID(), started = Date.now()): void {
        const raw = (error as {code?: unknown})?.code;
        try {this.options.presentation.log?.({operationId, stage, result: 'failure', ...failureDetails(error), code: typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : 'KANBAN_OPERATION_FAILED', durationMs: Date.now() - started});} catch { /* Diagnostics cannot change a read result. */ }
    }
    private async showChildren(generation: number, cursor?: string): Promise<void> {
        const {service} = this.options, item = this.item, board = this.board;
        if (!service || !item || !board || !childType(board, item)) return;
        const query = {parentId: item.id, view: 'all' as const, limit: 50, ...(cursor ? {cursor} : {})};
        const page = await (service.queryActivity?.(board.id, query) ?? service.query(board.id, query));
        if (!this.alive(generation)) return;
        this.panel().querySelector('[data-children]')!.innerHTML = childrenView(this.options.presentation, page, cursor, !['completed', 'cancelled'].includes(item.status) && !item.closedAt, this.options.sessionUrl);
    }
    private async showRecords(generation: number): Promise<void> {
        if (!this.recordKind || !this.options.service) return;
        let page: import('../contracts').KanbanRecordPage;
        try {page = await this.options.service.records(this.boardId, {kind: this.recordKind, limit: 50, ...(this.recordCursor ? {cursor: this.recordCursor} : {})});}
        catch (error) {
            if ((error as {code?: string})?.code !== 'CURSOR_STALE' || !this.recordCursor) throw error;
            this.recordCursor = undefined;
            page = await this.options.service.records(this.boardId, {kind: this.recordKind, limit: 50});
        }
        if (!this.alive(generation)) return;
        this.recordPage = page; this.content().innerHTML = this.ui.recordsView(page, this.recordKind, !!this.recordCursor, this.board);
    }
    private async showRecord(id: string, generation = this.generation): Promise<void> {
        if (!this.options.service) return;
        const record = await this.options.service.record(this.boardId, id);
        const executions = record.kind === 'decision' ? await this.options.service.recordExecutions?.(this.boardId, id) : undefined;
        if (!this.alive(generation)) return;
        this.recordId = id; this.drawer.show(this.ui.recordDetail(record, this.board!, executions), 'record:' + id); await this.showReferenceLinks(record.externalRefs ?? [], generation); this.options.selected(this.getActiveResourceId());
    }
    private async showReferenceLinks(references: import('../contracts').KanbanExternalReference[], generation: number, skip = new Set<string>()): Promise<void> {
        if (!this.options.referenceLink) return;
        const started = Date.now();
        const results = await Promise.allSettled(references.filter(ref => !skip.has(ref.id)).map(ref => this.options.referenceLink!(ref)));
        if (!this.alive(generation)) return;
        const resolved = results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
        const links = [...new Map(resolved.map(link => [link.href, link])).values()];
        const slot = this.panel().querySelector('[data-reference-links]');
        if (slot) slot.innerHTML = links.map(link => linkPair(this.options.presentation, link.href, link.label, link.sessionId)).join('');
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (errors.length) {
            const raw = (errors[0].reason as {code?: unknown})?.code, code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : 'SESSION_LINK_UNAVAILABLE';
            if (slot) {const error = document.createElement('p'); error.setAttribute('role', 'alert'); error.textContent = this.ui.label('sessionLinkUnavailable') + ' (' + code + ')'; slot.append(error);}
            this.options.presentation.log?.({operationId: randomUUID(), stage: 'ui.reference-links', result: 'failure', code, ...failureDetails(errors[0].reason), durationMs: Date.now() - started});
        }
    }
    private async loadWorkResources(inspect = false, refresh = false): Promise<void> {
        const service = this.options.service, boardId = this.boardId, itemId = this.item?.id;
        const section = this.panel().querySelector<HTMLDetailsElement>('[data-work-resources]');
        if (!service?.workResources || !itemId || !section || section.dataset.loading || !refresh && section.dataset.loaded) return;
        const operationId = randomUUID(), started = Date.now(), revision = section.dataset.associationRevision; section.dataset.loading = 'true';
        if (!section.dataset.loaded) this.setSection('[data-work-resource-body]', `<p role="status">${escapeHTML(this.ui.label('loading'))}</p>`);
        try {
            const resources = await service.workResources(boardId, itemId, {inspect});
            if (this.abort.signal.aborted || !section.isConnected || this.item?.id !== itemId || this.boardId !== boardId || revision !== section.dataset.associationRevision) return;
            this.setSection('[data-work-resource-body]', workResourcesView(this.options.presentation, resources)); section.dataset.loaded = 'true';
        } catch (error) {
            if (!section.isConnected || this.abort.signal.aborted) return;
            this.reportRead('ui.item.work-resources', error, operationId, started);
            const body = section.querySelector('[data-work-resource-body]'), notice = document.createElement('p');
            notice.setAttribute('role', 'alert'); notice.textContent = errorText(error, this.ui.label, 'ui.item.work-resources'); body?.append(notice);
        } finally {
            delete section.dataset.loading;
            if (!this.abort.signal.aborted && section.isConnected && section.open && revision !== section.dataset.associationRevision) void this.loadWorkResources(false, true);
        }
    }
    private async loadRelatedSessions(refresh = false): Promise<void> {
        const service = this.options.service, boardId = this.boardId, itemId = this.item?.id;
        const details = this.panel().querySelector<HTMLDetailsElement>('[data-related-sessions]');
        if (!service?.executionSession || !itemId || !details || details.dataset.loading || !refresh && details.dataset.loaded) return;
        details.dataset.loading = 'true';
        this.setSection('[data-related-sessions-body]', `<p role="status">${escapeHTML(this.ui.label('loading'))}</p>`);
        try {
            await this.supplement('ui.item.related-sessions', this.generation, () => service.executionSession!(boardId, itemId, {includeRelated: true}), detail => {
                if (this.item?.id !== itemId || this.boardId !== boardId) return;
                this.setSection('[data-related-sessions-body]', relatedSessionsView(this.options.presentation, detail, this.options.sessionUrl));
                details.dataset.loaded = 'true';
            }, '[data-related-sessions-body]');
        } finally {delete details.dataset.loading;}
    }
    private async click(event: Event): Promise<void> {
        const target = (event.target as HTMLElement).closest<HTMLElement>('button, a'); if (!target || target.matches(':disabled')) return;
        if (target.dataset.action === 'refresh-related-sessions') {await this.loadRelatedSessions(true); return;}
        for (const menu of this.options.editor.querySelectorAll<HTMLDetailsElement>('[data-popover][open]')) if (!menu.contains(target)) menu.open = false;
        if (target.dataset.session) {event.preventDefault(); await this.options.openSession(target.dataset.session); return;}
        if (this.dirty && !['close-panel', 'copy-reference', 'copy-link', 'copy-resource'].includes(target.dataset.action ?? '')) throw new Error(this.ui.label('unsaved'));
        const path = this.navigationTarget(target);
        if (path && this.options.navigate) {await this.options.navigate(path); return;}
        if (target.dataset.board) {await this.navigate(target.dataset.board); return;}
        if (target.dataset.context) {this.recordKind = target.dataset.context === 'board' ? undefined : target.dataset.context as 'log' | 'decision'; this.recordCursor = undefined; this.closePanel(); await this.refresh(); return;}
        if (target.dataset.record) {this.itemId = ''; this.item = undefined; await this.showRecord(target.dataset.record); return;}
        if (target.dataset.item) {this.recordId = ''; this.itemId = target.dataset.item; await this.showItem(); return;}
        const action = target.dataset.action;
        if (action === 'continue-execution' && this.item && target.dataset.dispatch) {
            await this.execute({type: 'continue-execution', previousDispatchId: target.dataset.dispatch, dispatchId: randomUUID()}); return;
        }
        if (action === 'refresh-work-resources' || action === 'inspect-work-resources') {await this.loadWorkResources(action === 'inspect-work-resources', true); return;}
        if (action === 'cleanup-work-resource' && this.item && this.options.service?.cleanupWorkResource) {
            if (!globalThis.confirm(this.ui.label('cleanupWorkResourceConfirm'))) return;
            try {await this.options.service.cleanupWorkResource(this.boardId, {operationId: randomUUID(), itemId: this.item.id, resourceId: target.dataset.resource!, version: target.dataset.version!});}
            finally {await this.loadWorkResources(false, true);} return;
        }
        if (action === 'close-panel' || action === 'dismiss-panel') {await this.requestClose(action === 'close-panel'); return;}
        if (action === 'copy-reference' || action === 'copy-link' || action === 'copy-resource') {await this.ui.copyReference(target.closest<HTMLElement>('[data-action]')!); return;}
        if (action === 'automation' && this.board && this.options.service?.automationCatalog) {
            this.automationCatalog = await this.options.service.automationCatalog();
            this.itemId = ''; this.drawer.show(automationForm(this.options.presentation, this.board, this.automationCatalog), 'automation'); this.dirty = true; return;
        }
        if (action === 'task-edit' && this.item && this.board) {
            const editId=randomUUID(),itemId=this.item.id;
            await this.execute({type:'begin-edit',itemId,editId,leaseMs:300000});
            this.editing={itemId,editId};
            const resources=await this.options.service?.itemResources?.(this.boardId);
            if(resources)resources.selected=this.item.externalRefs?.find(ref=>resources.resources.some(r=>r.reference.system===ref.system&&r.reference.id===ref.id));
            this.drawer.show(editTaskForm(this.options.presentation,this.board,this.item,editId,resources),'edit:'+itemId);this.dirty=true;return;
        }
        if (action === 'task-fix' && this.item && this.options.service?.fixTask) {
            target.dataset.operationId ??= randomUUID();
            const fix=await this.options.service.fixTask(this.boardId,{itemId:this.item.id,operationId:target.dataset.operationId});
            await this.options.openSession(fix.sessionId);return;
        }
        if (action?.startsWith('task-') && this.item) {
            if(action==='task-cancel')await this.execute({type:'cancel-item',itemId:this.item.id,reason:this.ui.label('taskAction.cancel')});
            else if(action==='task-run')await this.execute({type:'request-run',itemId:this.item.id});
            else if(action==='task-pause'||action==='task-resume')await this.execute({type:'request-control',itemId:this.item.id,controlId:randomUUID(),action:action==='task-pause'?'pause':'resume'});
            return;
        }
        if (action === 'reanalyze' && this.item?.planning) {await this.execute({type:'retry-analysis',itemId:this.item.id,retryId:randomUUID()}); return;}
        if (action === 'new-board') {this.showBoardForm(); return;}
        if (action === 'children-next' || action === 'children-first') {await this.showChildren(this.generation, action === 'children-next' ? target.dataset.cursor : undefined); return;}
        if (action === 'new-child' && this.board && this.item && childType(this.board, this.item)) {
            await this.showItemForm(this.item);return;
        }
        if (action === 'new-item' && this.board) {await this.showItemForm();return;}
        if (action === 'new-log' || action === 'new-decision') {
            const resources = action === 'new-decision' ? await this.options.service?.recordResources?.() : [];
            this.recordId = ''; this.drawer.show(this.ui.recordForm(action === 'new-log' ? 'log' : 'decision', this.board!, this.itemId, resources), action); this.dirty = true; return;
        }
        if ((action === 'run-record' || action === 'run-record-separate') && this.options.service?.runRecord) {
            const record = await this.options.service.record(this.boardId, this.recordId);
            target.dataset.operationId ??= randomUUID();
            await this.options.service.runRecord(this.boardId, {operationId: target.dataset.operationId, recordId: record.id, expectedRevision: record.revision, placement: action === 'run-record-separate' ? 'new-board' : 'current-board'});
            this.options.committed?.(); await this.refresh(); return;
        }
        if (action === 'scroll-left' || action === 'scroll-right') {const board = this.content().querySelector<HTMLElement>('.kanban__columns'); if (board) board.scrollLeft += board.clientWidth * (action === 'scroll-left' ? -0.8 : 0.8); return;}
        if (action === 'records-next' || action === 'records-first') {this.recordCursor = action === 'records-next' ? this.recordPage?.nextCursor : undefined; await this.refresh(); return;}
        if ((action === 'confirm-record' || action === 'reject-record') && this.recordId) {await this.execute({type: 'review-record', recordId: this.recordId, accept: action === 'confirm-record'}); return;}
        if (action === 'next' || action === 'first') {this.query.cursor = action === 'next' ? this.page?.nextCursor : undefined; await this.refresh(); return;}
        if (action === 'refresh-item-operations') {this.dirty = false; await this.loadOperations(this.generation); this.options.changed?.(); return;}
        if (action === 'refresh') {await this.refresh(); return;}
        if (action && this.item) await this.execute(actionCommand(action, this.item));
    }
    private async openReference(reference: string): Promise<void> {
        if (this.dirty) throw new Error(this.ui.label('unsaved'));
        const target = await this.options.service!.resolve(reference);
        if (this.options.navigate) {
            const leaf = target.recordId ? '/@record/' + encodeURIComponent(target.recordId) : target.itemId ? '/' + encodeURIComponent(target.itemId) : '';
            await this.options.navigate(`/board/${encodeURIComponent(target.boardId)}${leaf}`); return;
        }
        this.closePanel(); this.boardId = target.boardId; this.itemId = target.itemId ?? ''; this.recordId = target.recordId ?? '';
        this.recordKind = undefined; this.recordCursor = undefined; this.query = {view: 'all', limit: 50};
        await this.refresh();
        this.options.activated?.();
    }
    private async navigate(id: string): Promise<void> {
        this.boardId = id; this.itemId = ''; this.recordKind = undefined; this.recordCursor = undefined; this.query = {view: 'all', limit: 50}; this.closePanel(); await this.refresh();
    }
    private async submit(event: Event): Promise<void> {
        const form = event.target as HTMLFormElement, kind = form.dataset.form, data = new FormData(form);
        form.dataset.resourceId ??= randomUUID();
        if (!form.reportValidity()) return;
        if (kind === 'item-operation' || kind === 'operation-binding') {await this.submitOperation(form, data, kind === 'operation-binding'); return;}
        if (kind === 'reference') {await this.openReference(value(data, 'reference')); return;}
        if (kind === 'filter') {
            if (this.dirty) throw new Error(this.ui.label('unsaved'));
            this.query = {phase:(value(data,'phase')||undefined) as KanbanSessionActivityQuery['phase'], view: value(data, 'view') as KanbanSessionActivityQuery['view'],execution:(value(data,'execution')||'all') as KanbanSessionActivityQuery['execution'], search: value(data, 'search'), area: value(data, 'area') || undefined, milestone: value(data, 'milestone') || undefined, limit: 50};
            await this.refresh(); return;
        }
        if (kind === 'board' && this.actor && this.options.service) {
            const created = await this.options.service.create(boardInput(data, this.actor, form.dataset.resourceId));
            this.options.committed?.(); this.dirty = false; await this.navigate(created.id); return;
        }
        if (kind === 'automation' && this.automationCatalog) {
            await this.execute({type: 'configure-automation', settings: {enabled: data.has('enabled'), autoAccept: data.has('autoAccept'),
                ...(value(data, 'preparation') ? {preparation: JSON.parse(value(data, 'preparation')),
                    preparationOptions: Object.fromEntries([...data.entries()].filter(([key]) => key.startsWith('preparation-option-'))
                        .map(([key, value]) => [key.slice('preparation-option-'.length), String(value)]))} : {}),
                planner: JSON.parse(value(data, 'planner')), executor: JSON.parse(value(data, 'executor')),
                coordinator: this.automationCatalog.coordinator, worker: this.automationCatalog.worker}}); return;
        }
        if(kind==='task-reply'&&this.item&&this.options.service?.replyTask) {
            await this.options.service.replyTask(this.boardId,{itemId:this.item.id,attemptId:value(data,'attemptId'),replyTo:value(data,'replyTo'),operationId:form.dataset.resourceId,content:value(data,'content')});
            this.dirty=false;await this.refresh();return;
        }
        if(kind==='save-edit'&&this.item) {
            const planning=formCommand('plan',data,this.board!,this.item);
            if(planning.type!=='plan-item')return;
            await this.execute({type:'save-edit',launchMode:value(data,'launchMode') as 'automatic'|'manual',itemId:this.item.id,editId:value(data,'editId'),title:value(data,'title'),responsibility:value(data,'responsibility'),acceptance:value(data,'acceptance'),planning:planning.planning,externalRefs:[...(this.item.externalRefs??[]).filter(ref=>!value(data,'itemResource')||ref.system!==JSON.parse(value(data,'itemResource')).system),...(value(data,'itemResource')?[JSON.parse(value(data,'itemResource'))]:[])]});
            this.editing=undefined;return;
        }
        if (kind === 'amendment') data.set('amendmentId', form.dataset.amendment ?? '');
        if (kind === 'record-link' && this.recordId) {await this.execute({type: 'link-record', recordId: this.recordId, itemId: value(data, 'itemId')}); return;}
        if (kind && this.board) {
            if (kind === 'execution-session' && this.item && this.options.executionReference) {
                await this.execute({type: 'link-reference', itemId: this.item.id, reference: this.options.executionReference(value(data, 'executionSession'), form.dataset.resourceId)}); return;
            }
            await this.execute(formCommand(kind, data, this.board, this.item, form.dataset.resourceId));
        }
    }
    private async showItemForm(parent?:KanbanItem):Promise<void> {
        const board=this.board,generation=this.generation;if(!board)return;
        const resources=await this.options.service?.itemResources?.(board.id,parent?.id);
        if(this.abort.signal.aborted||generation!==this.generation)return;
        this.itemId='';this.drawer.show(this.ui.newItemForm(board,parent,resources),parent?'new-child':'new-item');this.dirty=true;
    }
    private async execute(command: KanbanCommand): Promise<void> {
        if (!this.board || !this.options.service) return;
        if (command.type === 'review') {
            const workflow = await this.options.service.workflow(this.board.id);
            const dispatch = Object.values(workflow.dispatches).find(dispatch => dispatch.itemId === ('itemId' in command ? command.itemId : '') && dispatch.outcome === 'succeeded');
            if (dispatch) command = {type: 'accept-execution', dispatchId: dispatch.id, accept: command.accept};
        }
        const fingerprint = JSON.stringify(command);
        if (this.pending && (this.pending.boardId !== this.board.id || this.pending.fingerprint !== fingerprint)) throw Object.assign(new Error('Pending write'), {code: 'WRITE_OUTCOME_UNKNOWN'});
        this.pending ??= {boardId: this.board.id, fingerprint, request: {operationId: randomUUID(), expectedRevision: this.board.revision, command}};
        try {await this.options.service.execute(this.board.id, this.pending.request);}
        catch (error) {
            if ((error as Error)?.name === 'KanbanError' || (error as {outcome?: string})?.outcome === 'not-committed') this.pending = undefined;
            throw error;
        }
        this.pending = undefined; this.options.committed?.();
        if (command.type === 'configure-automation') this.closePanel();
        this.dirty = false; this.query.cursor = undefined; this.recordCursor = undefined;
        if (command.type === 'create-item') this.itemId = command.item.id;
        if (command.type === 'append-record') {this.recordId = command.record.id; this.itemId = ''; this.item = undefined;}
        await this.refresh();
    }
    private async run(action: () => Promise<void>): Promise<void> {
        if (this.busy || this.abort.signal.aborted) return;
        const operationId = randomUUID(), started = Date.now();
        this.operationStage = 'ui.operation';
        this.generation++; this.busy = true; this.status(this.ui.label('loading')); this.error(''); this.options.editor.setAttribute('aria-busy', 'true');
        let succeeded = false;
        try {await action(); succeeded = true;}
        catch (error) {
            const raw = (error as {code?: unknown})?.code;
            try {this.options.presentation.log?.({operationId, stage: this.operationStage, result: 'failure', ...failureDetails(error), code: typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : 'KANBAN_OPERATION_FAILED', durationMs: Date.now() - started});} catch { /* Reporting cannot alter drafts. */ }
            if (!this.abort.signal.aborted) this.error(errorText(error, this.ui.label, this.operationStage));
        }
        finally {
            this.busy = false;
            if (!this.abort.signal.aborted) {
                this.status(''); this.options.editor.removeAttribute('aria-busy'); this.options.editor.inert = false; this.mountHeaderActions(); this.drawer.flushFocus(); this.options.changed?.();
                if (succeeded && this.invalid && this.visible && !this.dirty) this.refreshInBackground();
            }
        }
    }
    private navigationTarget(target: HTMLElement): string | undefined {
        if (target.dataset.board) return `/board/${encodeURIComponent(target.dataset.board)}`;
        const board = `/board/${encodeURIComponent(this.boardId)}`;
        if (target.dataset.item) return `${board}/${encodeURIComponent(target.dataset.item)}`;
        if (target.dataset.record) return `${board}/@record/${encodeURIComponent(target.dataset.record)}`;
        if (target.dataset.context) return board + (target.dataset.context === 'board' ? '' : '/@' + target.dataset.context);
    }
    private mountHeaderActions(): void {
        for (const [slot, release] of this.windowMounts) if (!this.options.editor.contains(slot)) {release(); this.windowMounts.delete(slot);}
        if (this.options.mountTitleBar) {
            for (const header of this.options.editor.querySelectorAll<HTMLElement>('[data-titlebar]')) if (!this.windowMounts.has(header)) this.mountTitleBar(header);
            return;
        }
        for (const slot of this.options.editor.querySelectorAll<HTMLElement>('[data-window-navigation]')) {
            if (!this.windowMounts.has(slot) && this.options.mountWindowList) this.windowMounts.set(slot, this.options.mountWindowList(slot));
        }
        for (const header of this.options.editor.querySelectorAll<HTMLElement>('[data-titlebar]')) if (!this.windowMounts.has(header)) this.mountDefaultTitleBar(header);
    }
    private mountDefaultTitleBar(header: HTMLElement): void {
        const back = header.querySelector<HTMLElement>('[data-titlebar-back]') ?? undefined;
        const title = header.querySelector<HTMLElement>('[data-titlebar-title]') ?? undefined;
        back?.classList.add('ui-nav-button'); header.querySelector('.kanban__menu > summary')?.classList.add('ui-nav-button');
        const view = mountSharedTitleBar(header, {
            title, back,
            leading: [...header.querySelectorAll<HTMLElement>('[data-navigation] > button')],
            trailing: [...header.querySelectorAll<HTMLElement>('[data-window-navigation]')],
            actions: [...header.querySelectorAll<HTMLElement>('.kanban__desktop-create, :scope > [data-action=new-board]')],
            menu: header.querySelector<HTMLElement>('.kanban__menu') ?? undefined,
        });
        view.element.dataset.titlebarSlot = ''; header.dataset.titlebarHost = 'true';
        view.update({title: title?.textContent ?? ''});
        this.windowMounts.set(header, () => {view.destroy(); delete header.dataset.titlebarHost;});
    }
    private mountTitleBar(header: HTMLElement): void {
        const slot = document.createElement('div'); slot.dataset.titlebarSlot = ''; header.prepend(slot); header.dataset.titlebarHost = 'true';
        const release = this.options.mountTitleBar!(slot, {
            title: header.querySelector<HTMLElement>('[data-titlebar-title]') ?? undefined,
            back: header.querySelector<HTMLElement>('[data-titlebar-back]') ?? undefined,
            menu: header.querySelector<HTMLElement>('.kanban__menu') ?? undefined,
            actions: [...header.querySelectorAll<HTMLElement>('.kanban__desktop-create, :scope > [data-action=new-board]')],
        });
        this.windowMounts.set(header, () => {release(); slot.remove(); delete header.dataset.titlebarHost;});
    }
    private closePanel(): void {this.dirty = false; this.itemId = ''; this.recordId = ''; this.item = undefined; this.drawer.close();}
    private async requestClose(explicit: boolean): Promise<void> {
        if (this.editing && explicit) {await this.execute({type:'end-edit',...this.editing});this.editing=undefined;}
        if (this.dirty && !explicit) throw new Error(this.ui.label('unsaved'));
        if (this.options.navigate && this.boardId) {
            if (this.dirty) this.closePanel();
            await this.options.navigate(`/board/${encodeURIComponent(this.boardId)}`); return;
        }
        this.closePanel(); void this.refreshActivity(this.generation); this.options.selected(this.getActiveResourceId());
    }
    private alive(generation: number): boolean {return generation === this.generation && !this.abort.signal.aborted;}
    private content(): HTMLElement {return this.options.editor.querySelector('[data-content]')!;}
    private panel(): HTMLElement {return this.options.editor.querySelector('[data-panel]')!;}
    private status(message: string): void {this.options.editor.querySelector('[data-status]')!.textContent = message;}
    private error(message: string): void {
        const error = this.options.editor.querySelector<HTMLElement>('[data-error]')!; error.textContent = message; error.hidden = this.drawer?.open ?? false;
        const panelError = this.options.editor.querySelector('[data-panel-error]'); if (panelError) panelError.textContent = message;
        const executionError=this.options.editor.querySelector<HTMLElement>('[data-execution-error]');
        if(executionError) {
            executionError.textContent=message;executionError.hidden=!message;
            if(message) {const panel=this.panel(),bottom=executionError.getBoundingClientRect().bottom,edge=panel.getBoundingClientRect().bottom;if(bottom>edge) panel.scrollTop+=bottom-edge+12;}
        }
        this.options.editor.querySelector<HTMLElement>('[data-retry]')!.hidden = !message || (this.drawer?.open ?? false);
    }
}
function errorText(error: unknown, label: (key: string) => string, stage: string): string {
    const code = (error as {outcome?: string})?.outcome === 'unknown' ? 'WRITE_OUTCOME_UNKNOWN' : (error as {code?: unknown})?.code;
    if (code === 'REVISION_CONFLICT' || code === 'CURSOR_STALE') return label('conflict');
    if (error instanceof Error && error.message === label('unsaved')) return error.message;
    const safe = typeof code === 'string' && /^[A-Z_]{1,80}$/.test(code) ? code : 'KANBAN_OPERATION_FAILED';
    const translated = label('errors.' + safe);
    const details = safe === 'KANBAN_OPERATION_FAILED' ? failureDetails(error) : {};
    const diagnostic = details.errorName ? `\n${label('diagnostic')}: ${stage} · ${details.errorName}${details.source ? ' · ' + details.source : ''}` : '';
    return (translated !== 'kanban.errors.' + safe && translated !== 'errors.' + safe ? `${translated} (${safe})` : `${label('failed')}: ${safe}`) + diagnostic;
}

export async function mountKanban(container: HTMLElement, options: Omit<KanbanUIOptions, 'sidebar' | 'editor'>) {
    const sidebar = document.createElement('aside'), editor = document.createElement('main');
    container.classList.add('kanban-layout'); container.replaceChildren(sidebar, editor);
    const view = new KanbanWorkbench({...options, sidebar, editor}, container);
    await view.start();
    return view;
}
export {KanbanSuggestionPicker} from './suggestion-picker';
export type {SuggestionField} from './suggestion-field';
export type {KanbanUIOptions, KanbanPresentation, KanbanReviewGuidance} from './ports';
