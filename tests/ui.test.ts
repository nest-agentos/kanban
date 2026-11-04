// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {createKanbanModule, SeqKanbanStore} from '../src';
import {mountKanban, type KanbanPresentation} from '../src/ui';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close(); document.body.replaceChildren();});
const presentation = (prefix: string): KanbanPresentation => ({text: key => `${prefix}:${key}`, icons: {refreshView: '', more: '', close: ''}, log: vi.fn()});
async function fixture(prefix = 'one', mountNavigation?: (container: HTMLElement) => () => void) {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    closes.push(() => manager.dispose());
    const store = await SeqKanbanStore.open(await manager.openFileSystem('/'));
    const service = createKanbanModule({store, actor: {kind: 'human', id: 'person'}, authorize: async () => {}, log: vi.fn()});
    const root = document.createElement('section'); document.body.append(root);
    const view = await mountKanban(root, {service, presentation: presentation(prefix), selected: vi.fn(), openSession: vi.fn(), mountNavigation});
    closes.push(() => view.destroy());
    return {root, service, view};
}
async function idle(root: HTMLElement) {await vi.waitFor(() => expect(root.querySelector('main')!.hasAttribute('aria-busy')).toBe(false));}
async function click(root: HTMLElement, selector: string) {await vi.waitFor(() => expect(root.querySelector(selector)).not.toBeNull()); root.querySelector<HTMLButtonElement>(selector)!.click(); await idle(root);}
function fill(root: HTMLElement, name: string, value: string) {
    const field = root.querySelector<HTMLInputElement>(`[name=${name}]`)!;
    field.value = value; field.dispatchEvent(new Event('input', {bubbles: true}));
}
async function submit(root: HTMLElement, kind: string) {await click(root, `[data-form=${kind}] button:not([type])`);}
it('mounts an independent board, completes and restores work entirely through DOM controls', async () => {
    const {root, service} = await fixture();
    await click(root, '[data-action=new-board]'); fill(root, 'title', '<Independent>'); await submit(root, 'board');
    expect(root.querySelector('main h2')?.textContent).toBe('<Independent>'); expect(root.querySelector('independent')).toBeNull();
    expect(root.querySelector('[name=execution]')).toBeNull();
    await click(root, '[data-action=new-item]'); fill(root, 'title', 'First'); fill(root, 'responsibility', 'Do work'); fill(root, 'acceptance', 'Verify'); await submit(root, 'item');
    const board = (await service.list())[0], id = board.items[0].id;
    const header = root.querySelector('[data-panel] .kanban__panel-header')!;
    expect(header.querySelector('.ui-content-titlebar')?.firstElementChild?.getAttribute('data-action')).toBe('close-panel');
    expect(header.querySelector('h3')?.getAttribute('title')).toBe('First');
    expect(header.querySelector('[data-action=copy-link]')?.getAttribute('data-copy')).toBe(`/board/${board.id}/${id}`);
    expect(root.querySelector('[data-panel] .kanban__reference')).toBeNull();
    await click(root, '[data-panel] .kanban__panel-back');
    expect(root.querySelector<HTMLElement>('[data-panel]')!.hidden).toBe(true);
    await click(root, `[data-item="${id}"]`);
    await click(root, '[data-action=ready]'); await submit(root, 'claim'); fill(root, 'resultRef', 'record:result'); await submit(root, 'submit');
    expect((await service.item(board.id, id)).item.status).toBe('completed');
    await click(root, '[data-action=archive]'); expect((await service.item(board.id, id)).archive).toBeDefined();
    await click(root, '[data-action=restore]'); expect((await service.item(board.id, id)).archive).toBeUndefined();
});
it('keeps reference and secondary actions in the menu and preserves filters and host navigation across refreshes', async () => {
    const release = vi.fn(), mount = vi.fn((container: HTMLElement) => {
        const button = document.createElement('button'); button.dataset.hostNavigation = ''; container.append(button); return release;
    });
    const {root, view} = await fixture('one', mount);
    await click(root, '[data-action=new-board]'); fill(root, 'title', 'Mobile board'); await submit(root, 'board');
    const header = root.querySelector('main .kanban__page-header')!;
    expect(header.querySelector('.kanban__board-heading code')).toBeNull();
    expect(header.querySelector('.kanban__menu-reference')).not.toBeNull();
    expect(header.querySelector('.kanban__menu [data-action=refresh]')).not.toBeNull();
    expect(root.querySelector('[data-host-navigation]')).not.toBeNull();
    const filter = root.querySelector<HTMLSelectElement>('[name=view]')!; filter.value = 'archive';
    expect(filter.closest('details')).not.toBeNull(); await submit(root, 'filter');
    expect(root.querySelector<HTMLSelectElement>('[name=view]')!.value).toBe('archive');
    expect(mount).toHaveBeenCalledTimes(3); expect(release).toHaveBeenCalledTimes(2);
    await view.destroy(); expect(release).toHaveBeenCalledTimes(3);
});
it('isolates presentation between simultaneous instances and preserves drafts through failed writes', async () => {
    const first = await fixture('first'), second = await fixture('second');
    await click(first.root, '[data-action=new-board]'); fill(first.root, 'title', 'Draft');
    first.view.invalidateFromEvents();
    await expect(first.view.openResource('/')).rejects.toThrow('first:unsaved');
    vi.spyOn(first.service, 'create').mockRejectedValueOnce(Object.assign(new Error('private text'), {code: 'EIO'}));
    await submit(first.root, 'board');
    expect(first.root.querySelector<HTMLInputElement>('[name=title]')!.value).toBe('Draft');
    expect(first.root.textContent).toContain('EIO'); expect(first.root.textContent).not.toContain('private text');
    expect(first.root.textContent).not.toContain('second:'); expect(second.root.textContent).not.toContain('first:');
    await submit(first.root, 'board'); expect((await first.service.list())).toHaveLength(1);
});
it('configures published AI targets through the board menu and defaults to independent acceptance', async () => {
    const {root, service} = await fixture();
    const catalog = {targets: [{label: 'Planner', reference: {system: 'published', id: 'planner', revision: '1'}},
        {label: 'Executor', reference: {system: 'published', id: 'executor', revision: '1'}}],
        coordinator: {kind: 'service' as const, id: 'planner'}, worker: {kind: 'service' as const, id: 'worker'}};
    Object.assign(service, {automationCatalog: async () => catalog});
    await click(root, '[data-action=new-board]'); fill(root, 'title', 'AI work'); await submit(root, 'board');
    expect(root.querySelector('.kanban__menu [data-action=automation]')).not.toBeNull();
    await click(root, '[data-action=automation]');
    expect(root.querySelector<HTMLInputElement>('[name=autoAccept]')!.checked).toBe(false);
    fill(root, 'planner', JSON.stringify(catalog.targets[0].reference)); fill(root, 'executor', JSON.stringify(catalog.targets[1].reference));
    root.querySelector<HTMLInputElement>('[name=enabled]')!.checked = true;
    await submit(root, 'automation');
    const board = (await service.list())[0];
    expect(board.automation).toMatchObject({enabled: true, autoAccept: false, planner: catalog.targets[0].reference});
    expect(board.policy.review).toBe('independent');
    expect(board.members?.find(member => member.id === 'worker')?.roles).toContain('worker');
    expect(root.querySelector<HTMLElement>('[data-panel]')!.hidden).toBe(true);
});
it('shows host preparation choices when selected and persists explicit commit policy', async () => {
    const {root, service} = await fixture();
    const reference = {system: 'host-preparation', id: 'isolated', revision: '1'};
    const catalog = {targets: [{label: 'Agent', reference: {system: 'published', id: 'agent', revision: '1'}}],
        preparations: [{label: 'Workspace', reference, options: [{name: 'commit', label: 'Commit policy', defaultValue: 'changes', choices: [
            {value: 'changes', label: 'Keep changes'}, {value: 'worktree', label: 'Commit in task branch'}]}]}],
        coordinator: {kind: 'service' as const, id: 'planner'}, worker: {kind: 'service' as const, id: 'worker'}};
    Object.assign(service, {automationCatalog: async () => catalog});
    await click(root, '[data-action=new-board]'); fill(root, 'title', 'Policy'); await submit(root, 'board');
    await click(root, '[data-action=automation]');
    const preparation = root.querySelector<HTMLSelectElement>('[name=preparation]')!;
    preparation.value = JSON.stringify(reference); preparation.dispatchEvent(new Event('change', {bubbles: true}));
    expect(root.querySelector<HTMLSelectElement>('[name=preparation-option-commit]')?.value).toBe('changes');
    fill(root, 'preparation-option-commit', 'worktree');
    fill(root, 'planner', JSON.stringify(catalog.targets[0].reference)); fill(root, 'executor', JSON.stringify(catalog.targets[0].reference));
    await submit(root, 'automation');
    expect((await service.list())[0].automation).toMatchObject({preparation: reference, preparationOptions: {commit: 'worktree'}});
    const board = (await service.list())[0];
    await service.execute(board.id, {operationId: 'reorder-reference', expectedRevision: board.revision, command: {
        type: 'configure-automation', settings: {...board.automation!, preparation: {id: reference.id, revision: reference.revision, system: reference.system}}}});
    await viewRefresh();
    async function viewRefresh() {
        await click(root, '[data-action=refresh]'); await click(root, '[data-action=automation]');
        expect(root.querySelector<HTMLSelectElement>('[name=preparation-option-commit]')?.value).toBe('worktree');
    }

});

it('lists children on a feature, prefills its parent when creating work, and opens the parent from a task', async () => {
    const f = await fixture();
    const board = await f.service.create({id: 'hierarchy', title: 'Project', scope: {kind: 'system'}, members: [{kind: 'human', id: 'person', responsibility: 'Manage'}]});
    await f.service.execute(board.id, {operationId: 'feature', expectedRevision: board.revision, command: {type: 'create-item',
        item: {id: 'feature', title: 'Cloze modes', responsibility: 'Support modes', acceptance: 'Verified'}, planning: {kind: 'feature', priority: 2, dependencies: [], references: []}}});
    await f.view.openResource('/board/hierarchy/feature');
    await vi.waitFor(() => expect(f.root.querySelector('[data-children]')?.textContent).toContain('one:children (0)'));
    await click(f.root, '[data-action=new-child]');
    expect(new FormData(f.root.querySelector('[data-form=item]')!).get('parentId')).toBe('feature');
    expect(new FormData(f.root.querySelector('[data-form=item]')!).get('kind')).toBe('task');
    fill(f.root, 'title', 'Implement'); fill(f.root, 'responsibility', 'Code'); fill(f.root, 'acceptance', 'Tests'); await submit(f.root, 'item');
    const child = (await f.service.read(board.id)).items.find(item => item.title === 'Implement')!;
    expect(child.planning?.parentId).toBe('feature');
    await click(f.root, '[data-panel] [data-item=feature]');
    await vi.waitFor(() => expect(f.root.querySelector('[data-children]')?.textContent).toContain('Implement'));
    await click(f.root, '[data-children] [data-item]'); expect(f.view.getActiveResourceId()).toBe('/board/hierarchy/' + child.id);
});
it('runs a decision on its current board by default and requires an explicit action for a new board', async () => {
    const f = await fixture();
    const board = await f.service.create({id: 'development', title: 'Development', scope: {kind: 'system'}, members: [{kind: 'human', id: 'person', responsibility: 'Manage', roles: ['worker', 'reviewer', 'coordinator']}]});
    let state = await f.service.execute(board.id, {operationId: 'decision', expectedRevision: board.revision, command: {type: 'append-record',
        record: {id: 'cloze', kind: 'decision', title: 'Cloze', content: 'Add modes', rationale: 'Tested', itemIds: [], sources: []}}});
    await f.service.execute(board.id, {operationId: 'approve', expectedRevision: state.revision, command: {type: 'review-record', recordId: 'cloze', accept: true}});
    const runRecord = vi.fn(async () => ({id: 'run', recordId: 'cloze', recordRevision: 2, boardId: board.id, state: 'running', createdAt: 1, updatedAt: 1}));
    Object.assign(f.service, {recordExecutions: async () => [], runRecord});
    await f.view.openResource('/board/development/@record/cloze');
    await click(f.root, '[data-action=run-record]');
    expect(runRecord).toHaveBeenLastCalledWith(board.id, expect.objectContaining({placement: 'current-board'}));
    const separate = f.root.querySelector<HTMLButtonElement>('[data-action=run-record-separate]')!;
    separate.closest('details')!.open = true; await click(f.root, '[data-action=run-record-separate]');
    expect(runRecord).toHaveBeenLastCalledWith(board.id, expect.objectContaining({placement: 'new-board'}));
});
it('renders real Session anchors and preserves modified clicks for browser tabs', async () => {
    const f = await fixture();
    const board = await f.service.create({id: 'links', title: 'Links', scope: {kind: 'system'}, members: [{kind: 'human', id: 'person', responsibility: 'Manage'}]});
    await f.service.execute(board.id, {operationId: 'task', expectedRevision: board.revision, command: {type: 'create-item', item: {id: 'task', title: 'Task', responsibility: 'Work', acceptance: 'Verified'}}});
    Object.assign(f.service, {executionSession: async () => ({current: {sessionId: 'execution', title: 'Execution', state: 'running', observedAt: 1}, history: [{sessionId: 'execution', current: true}]})});
    const {KanbanWorkbench} = await import('../src/ui');
    const editor = document.createElement('main'); document.body.append(editor); const openSession = vi.fn(async () => {});
    const view = new KanbanWorkbench({editor, service: f.service, presentation: presentation('links'), selected: vi.fn(), openSession,
        sessionUrl: id => '#/workbench/' + id, initialResource: '/board/links/task'}); closes.push(() => view.destroy()); await view.start();
    const anchor = editor.querySelector<HTMLAnchorElement>('a[data-session=execution]')!;
    expect(anchor.href).toContain('#/workbench/execution'); expect(editor.querySelector('a[target=_blank]')).toBeNull();
    expect(editor.querySelectorAll('.kanban__execution-detail a[data-session=execution]')).toHaveLength(1);
    const modified = new MouseEvent('click', {bubbles: true, cancelable: true, ctrlKey: true}); anchor.dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(false); expect(openSession).not.toHaveBeenCalled();
    anchor.click(); await vi.waitFor(() => expect(openSession).toHaveBeenCalledWith('execution'));
});
it('shows projected activity as a read-only record with independently resolved Session links', async () => {
    const f = await fixture(); const board = await f.service.create({id: 'logs', title: 'Logs', scope: {kind: 'system'}, members: [{kind: 'human', id: 'person', responsibility: 'Manage'}]});
    const record = {id: 'activity-one', title: 'Completed', kind: 'log', content: 'Verified', status: 'confirmed', origin: 'flow', author: {kind: 'service', id: 'system'}, createdAt: 1, updatedAt: 1,
        itemIds: [], sources: [], revision: 1, activity: {stage: 'execution.succeeded', result: 'success'}, externalRefs: [{system: 'opaque', id: 'session'}, {system: 'opaque', id: 'alias'}]};
    const executions = vi.fn(async () => {throw new Error('Must not query a log as a decision');});
    Object.assign(f.service, {record: async () => record, recordExecutions: executions});
    const {KanbanWorkbench} = await import('../src/ui'); const editor = document.createElement('main'); document.body.append(editor);
    const view = new KanbanWorkbench({editor, service: f.service, presentation: presentation('logs'), selected: vi.fn(), openSession: vi.fn(), initialResource: '/board/logs/@record/activity-one',
        referenceLink: async () => ({href: '#/workbench/session', label: 'Execution', sessionId: 'session'})}); closes.push(() => view.destroy()); await view.start();
    expect(editor.querySelector('[data-form=record-link]')).toBeNull(); expect(executions).not.toHaveBeenCalled();
    expect(editor.querySelector<HTMLAnchorElement>('[data-reference-links] a')!.href).toContain('#/workbench/session');
    expect(editor.querySelectorAll('[data-reference-links] a[data-session=session]')).toHaveLength(1);
    expect(editor.querySelectorAll('[data-reference-links] a[target=_blank]')).toHaveLength(0);
});
it('returns an updated log view to the first page when background activity invalidates its cursor', async () => {
    const f = await fixture();
    await f.service.create({id: 'paging', title: 'Paging', scope: {kind: 'system'}, members: [{kind: 'human', id: 'person', responsibility: 'Manage'}]});
    const records = vi.fn(async (_board: string, query?: {cursor?: string}) => {
        if (query?.cursor) throw Object.assign(new Error('Stale'), {code: 'CURSOR_STALE'});
        return {revision: 1, total: 100, items: [], nextCursor: 'first-page'};
    }); Object.assign(f.service, {records});
    await f.view.openResource('/board/paging/@log'); await click(f.root, '[data-action=records-next]');
    expect(records.mock.calls.some(call => call[1]?.cursor === 'first-page')).toBe(true);
    expect(records.mock.calls.at(-1)![1]?.cursor).toBeUndefined();
    expect(f.root.querySelector('[data-action=records-first]')).toBeNull();
    expect(f.root.querySelector('[data-error]')?.textContent).toBe('');
});

it('uses a single locked resource for a task child and keeps decision resource selection multiple',async()=>{
    const f=await fixture(),reference={system:'project',id:'one'},resources=[{reference,label:'One'},{reference:{system:'project',id:'two'},label:'Two'}];
    Object.assign(f.service,{itemResources:vi.fn(async()=>({resources,selected:reference,required:true,readonly:true})),recordResources:async()=>resources});
    const board=await f.service.create({id:'resource-work',title:'Work',scope:{kind:'system'},members:[{kind:'human',id:'person',responsibility:'Manage'}]});
    await f.service.execute(board.id,{operationId:'create-parent',expectedRevision:board.revision,command:{type:'create-item',item:{id:'parent',title:'Parent',responsibility:'Work',acceptance:'Reviewed',externalRefs:[reference]}}});
    await f.view.openResource('/board/resource-work/parent');await click(f.root,'[data-action=new-child]');
    const form=f.root.querySelector<HTMLFormElement>('[data-form=item]')!,select=form.querySelector<HTMLSelectElement>('[name=itemResource]')!;
    expect(select.multiple).toBe(false);expect(select.disabled).toBe(true);expect(new FormData(form).get('kind')).toBe('subtask');
    expect(JSON.parse(String(new FormData(form).get('itemResource')))).toEqual(reference);
    fill(f.root,'title','Child');fill(f.root,'responsibility','Only child work');fill(f.root,'acceptance','Checked');await submit(f.root,'item');
    const child=(await f.service.read(board.id)).items.find(item=>item.title==='Child')!;
    expect(child.externalRefs).toEqual([reference]);expect(child.planning?.parentId).toBe('parent');
    await f.view.openResource('/board/resource-work/@decision');await click(f.root,'[data-action=new-decision]');
    expect(f.root.querySelector<HTMLSelectElement>('[name=recordResources]')?.multiple).toBe(true);
});

it('opens the card execution link directly without opening task details or nesting interactive controls',async()=>{
    const f=await fixture();
    await f.service.create({id:'direct-session',title:'Board',scope:{kind:'system'},members:[{kind:'human',id:'person',responsibility:'Manage'}],policy:{requireEstimate:false}});
    await f.service.execute('direct-session',{operationId:'create',expectedRevision:1,command:{type:'create-item',item:{id:'task',title:'Task',responsibility:'Work',acceptance:'Verified'}}});
    Object.assign(f.service,{queryActivity:async(board:string,query:Parameters<typeof f.service.query>[1])=>{
        const page=await f.service.query(board,query);
        return {...page,items:page.items.map(item=>({...item,execution:{sessionId:'execution',resourceId:'/native/execution',state:'running',observedAt:1}}))};
    }});
    const {KanbanWorkbench}=await import('../src/ui');
    const editor=document.createElement('main');document.body.append(editor);const openSession=vi.fn(async()=>{});
    const view=new KanbanWorkbench({editor,service:f.service,presentation:presentation('direct'),selected:vi.fn(),openSession,
        sessionUrl:id=>'#/workbench/'+id,initialResource:'/board/direct-session'});closes.push(()=>view.destroy());await view.start();
    await vi.waitFor(()=>expect(editor.querySelector('.kanban__card a[data-session]')).not.toBeNull());
    const link=editor.querySelector<HTMLAnchorElement>('.kanban__card a[data-session="/native/execution"]')!;
    expect(link.textContent).toBe('direct:executionSession');expect(link.closest('button')).toBeNull();
    expect(editor.querySelector('.kanban__card button[data-item=task]')).not.toBeNull();
    link.click();await vi.waitFor(()=>expect(openSession).toHaveBeenCalledExactlyOnceWith('/native/execution'));
    expect(editor.querySelector<HTMLElement>('[data-panel]')!.hidden).toBe(true);
});

it('removes run actions for completed decisions and directs users to new follow-up tasks',async()=>{
    const {recordDetail}=await import('../src/ui/context-view');
    const html=recordDetail(presentation('done'),{id:'decision',kind:'decision',status:'confirmed',title:'Done',author:{id:'person'},itemIds:[],sources:[],createdAt:1} as never,
        {id:'board',title:'Board',items:[]} as never,[{id:'run',boardId:'board',state:'completed'} as never]);
    const root=document.createElement('div');root.innerHTML=html;
    expect(root.querySelector('[data-action=run-record]')).toBeNull();expect(root.querySelector('[data-action=run-record-separate]')).toBeNull();
    expect(root.textContent).toContain('done:completedFollowup');
});
