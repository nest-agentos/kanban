// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule, SeqKanbanStore} from '../src';
import {KanbanWorkbench} from '../src/ui';
import type {KanbanClient, KanbanSessionItemPage, KanbanExecutionSessionDetail} from '../src/contracts';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren();});
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose());
    const store = await SeqKanbanStore.open(await manager.openFileSystem('/'));
    const service: KanbanClient = createKanbanModule({store, actor: {kind: 'human', id: 'owner'}, authorize: async () => {}, log: vi.fn()});
    await service.create({id: 'work', title: 'Work', scope: {kind: 'system'}, members: [{kind: 'human', id: 'owner', responsibility: 'Manage'}]});
    await service.execute('work', {operationId: 'create', expectedRevision: 1, command: {type: 'create-item', item: {id: 'one', title: 'Primary task', responsibility: 'Work', acceptance: 'Reviewed'}}});
    const editor = document.createElement('main'); document.body.append(editor); const log = vi.fn();
    const mount = async (path = '/board/work/one') => {
        const view = new KanbanWorkbench({editor, service, presentation: {text: key => key, icons: {refreshView: '', more: '', close: ''}, log}, selected: vi.fn(), openSession: vi.fn(), sessionUrl: id => '#/workbench/' + encodeURIComponent(id), initialResource: path});
        closes.push(() => view.destroy()); await view.start(); return view;
    };
    return {service, editor, mount, log};
}
it('shows and unlocks the primary task while supplementary reads remain pending', async () => {
    const f = await fixture(), gate = deferred<never>();
    f.service.executionSession = vi.fn(() => gate.promise);
    f.service.events = vi.fn(() => gate.promise); f.service.records = vi.fn(() => gate.promise);
    f.service.queryActivity = vi.fn(() => gate.promise);
    const view = await f.mount();
    expect(f.editor.querySelector('[data-panel]')?.textContent).toContain('Primary task');
    expect(f.editor.hasAttribute('aria-busy')).toBe(false); expect(f.editor.inert).not.toBe(true);
    expect(vi.mocked(f.service.queryActivity!).mock.calls.every(([, query]) => query?.parentId === 'one')).toBe(true);
    await view.openResource('/'); expect(view.getActiveResourceId()).toBe('/');
});
it('loads the related Session list only on expansion, links the native Session, and preserves it across activity polling', async () => {
    const f = await fixture(), state = {sessionId:'original',resourceId:'/native/original',title:'Original <Session>',state:'running' as const,stale:false,recent:true};
    const detail: KanbanExecutionSessionDetail = {current:state,history:[{sessionId:'original',current:true}],sessions:[{...state,current:true,purposes:['execution'],executions:[
        {id:'first',purpose:'execution',attempt:1,outcome:'failed'}, {id:'second',purpose:'execution',attempt:2,previousDispatchId:'first',roundId:'second',turnId:'turn-2',state:'running'},
    ]}]};
    const execution = vi.fn(async (_board, _item, query) => query?.includeRelated ? detail : {current:state,history:detail.history});
    f.service.executionSession = execution; const view = await f.mount();
    await vi.waitFor(()=>expect(f.editor.querySelector('[data-related-sessions]')).not.toBeNull());
    expect(execution.mock.calls.filter(([, , query])=>query?.includeRelated)).toHaveLength(0);
    const section = f.editor.querySelector<HTMLDetailsElement>('[data-related-sessions]')!;
    section.open = true; section.dispatchEvent(new Event('toggle'));
    await vi.waitFor(()=>expect(f.editor.querySelectorAll('[data-related-session]')).toHaveLength(1));
    expect(execution.mock.calls.filter(([, , query])=>query?.includeRelated)).toHaveLength(1);
    expect(section.querySelector('a')?.getAttribute('href')).toBe('#/workbench/%2Fnative%2Foriginal');
    expect(section.querySelector('a[target="_blank"]')).toBeNull(); expect(section.querySelector('session')).toBeNull();
    expect(section.textContent).toContain('turn-2'); expect(section.textContent).toContain('sessionContinuation');
    await (view as any).refreshActivity((view as any).generation);
    expect(f.editor.querySelector('[data-related-sessions]')).toBe(section); expect(section.open).toBe(true);
    expect(execution.mock.calls.filter(([, , query])=>query?.includeRelated)).toHaveLength(1);
    section.querySelector<HTMLButtonElement>('[data-action="refresh-related-sessions"]')!.click();
    await vi.waitFor(()=>expect(execution.mock.calls.filter(([, , query])=>query?.includeRelated)).toHaveLength(2));
});
it('shows an unfiltered board before activity is available and preserves card DOM on activity updates', async () => {
    const f = await fixture(), page = await f.service.query('work', {view: 'all', limit: 50}), gate = deferred<KanbanSessionItemPage>();
    f.service.queryActivity = vi.fn(() => gate.promise);
    await f.mount('/board/work');
    const card = f.editor.querySelector('[data-item=one]')!;
    expect(card).not.toBeNull(); expect(f.editor.hasAttribute('aria-busy')).toBe(false);
    gate.resolve({...page, items: page.items.map(item => ({...item, execution: {sessionId: 'original', resourceId: '/native/original', state: 'running', stale: false, recent: true}}))});
    await vi.waitFor(() => expect(f.editor.querySelector('[data-session="/native/original"]')).not.toBeNull());
    expect(f.editor.querySelector('[data-item=one]')).toBe(card);
});
it('keeps background refresh nonblocking and discards a late snapshot after editing begins', async () => {
    const f = await fixture(), view = await f.mount('/board/work'), boards = await f.service.catalog(), gate = deferred<typeof boards>();
    const catalog = vi.spyOn(f.service, 'catalog').mockReturnValue(gate.promise);
    view.invalidateFromEvents(); view.invalidateFromEvents();
    expect(catalog).toHaveBeenCalledOnce(); expect(f.editor.hasAttribute('aria-busy')).toBe(false); expect(f.editor.inert).not.toBe(true);
    f.editor.querySelector<HTMLButtonElement>('[data-action=new-item]')!.click();
    await vi.waitFor(() => expect(f.editor.querySelector('[data-form=item]')).not.toBeNull());
    const field = f.editor.querySelector<HTMLInputElement>('[name=title]')!; field.value = 'Unsaved'; field.dispatchEvent(new Event('input', {bubbles: true}));
    gate.resolve(boards); await Promise.resolve(); await Promise.resolve();
    expect(f.editor.querySelector('[name=title]')).toBe(field); expect(field.value).toBe('Unsaved');
});
it('does not replace an unsubmitted filter when a background activity response arrives', async () => {
    const f = await fixture(), gate = deferred<KanbanSessionItemPage>(), page = await f.service.query('work', {view: 'all'});
    f.service.queryActivity = vi.fn(() => gate.promise); await f.mount('/board/work');
    const field = f.editor.querySelector<HTMLInputElement>('[name=search]')!;
    field.focus(); field.value = 'Still typing'; field.dispatchEvent(new Event('input', {bubbles: true}));
    gate.resolve({...page, total: 2}); await Promise.resolve(); await Promise.resolve();
    expect(f.editor.querySelector('[name=search]')).toBe(field); expect(field.value).toBe('Still typing');
    expect(document.activeElement).toBe(field);
});
it('refreshes activity without rereading catalog, task bodies, events or records on the 15 second poll', async () => {
    vi.useFakeTimers(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const f = await fixture(), board = await f.service.read('work');
    await f.service.execute('work', {operationId: 'automation', expectedRevision: board.revision, command: {type: 'configure-automation', settings: {
        enabled: true, autoAccept: false, planner: {system: 'published', id: 'planner', revision: '1'}, executor: {system: 'published', id: 'worker', revision: '1'},
        coordinator: {kind: 'service', id: 'planner'}, worker: {kind: 'service', id: 'worker'},
    }}});
    f.service.queryActivity = vi.fn(async () => f.service.query('work'));
    const execution = vi.fn(async () => ({history: []})); f.service.executionSession = execution;
    const catalog = vi.spyOn(f.service, 'catalog'), item = vi.spyOn(f.service, 'item'), events = vi.spyOn(f.service, 'events'), records = vi.spyOn(f.service, 'records');
    await f.mount(); await vi.advanceTimersByTimeAsync(0);
    const before = [catalog.mock.calls.length, item.mock.calls.length, events.mock.calls.length, records.mock.calls.length];
    await vi.advanceTimersByTimeAsync(15000);
    expect([catalog.mock.calls.length, item.mock.calls.length, events.mock.calls.length, records.mock.calls.length]).toEqual(before);
    expect(execution).toHaveBeenCalledTimes(2); expect(f.editor.hasAttribute('aria-busy')).toBe(false); expect(f.editor.inert).not.toBe(true);
});
it('isolates supplementary failures and reports safe stage diagnostics without hiding the task', async () => {
    const f = await fixture();
    f.service.executionSession = vi.fn(async () => {throw Object.assign(new Error('PRIVATE_MESSAGE'), {code: 'EIO'});});
    await f.mount();
    await vi.waitFor(() => expect(f.editor.querySelector('[data-execution-session] [role=alert]')?.textContent).toContain('EIO'));
    expect(f.editor.querySelector('[data-panel]')?.textContent).toContain('Primary task');
    expect(f.editor.textContent).not.toContain('PRIVATE_MESSAGE'); expect(f.editor.hasAttribute('aria-busy')).toBe(false);
    expect(f.log).toHaveBeenCalledWith(expect.objectContaining({stage: 'ui.item.session', result: 'failure', code: 'EIO'}));
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('PRIVATE_MESSAGE');
});
it('loads host work resources only on expansion and leaves retained resources protected', async () => {
    const f = await fixture();
    f.service.workResources = vi.fn(async () => [{id: 'tree', kind: 'opaque', title: 'Workspace', location: '/retained',
        version: 'v1', state: 'retained', reasons: ['UNMERGED'], properties: [{label: 'Branch', value: 'work/one'}], canCleanup: false}]);
    f.service.cleanupWorkResource = vi.fn();
    await f.mount(); expect(f.service.workResources).not.toHaveBeenCalled();
    const section = f.editor.querySelector<HTMLDetailsElement>('[data-work-resources]')!;
    section.open = true; section.dispatchEvent(new Event('toggle'));
    await vi.waitFor(() => expect(f.editor.querySelector('[data-work-resource]')?.textContent).toContain('work/one'));
    expect(f.editor.querySelector<HTMLButtonElement>('[data-action=cleanup-work-resource]')!.disabled).toBe(true);
    expect(f.service.cleanupWorkResource).not.toHaveBeenCalled(); expect(f.editor.inert).not.toBe(true);
});
it('preserves an expanded resource section and its single pending read across repeated background events', async () => {
    const f = await fixture(), gate = deferred<any[]>();
    const resources = [{id: 'tree', kind: 'opaque', title: 'Workspace', location: '/retained', version: 'v1',
        state: 'retained' as const, reasons: ['UNMERGED'], properties: [], canCleanup: false}];
    f.service.workResources = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(resources);
    const view = await f.mount(), section = f.editor.querySelector<HTMLDetailsElement>('[data-work-resources]')!;
    section.open = true;
    await vi.waitFor(() => expect(f.service.workResources).toHaveBeenCalledOnce());
    view.invalidateFromEvents();
    gate.resolve(resources);
    await vi.waitFor(() => expect(f.editor.querySelector('[data-work-resource]')).not.toBeNull());
    expect(f.editor.querySelector('[data-work-resources]')).toBe(section); expect(section.open).toBe(true);
    view.invalidateFromEvents(); await new Promise(resolve=>setTimeout(resolve,30));
    expect(f.service.workResources).toHaveBeenCalledExactlyOnceWith('work','one',{inspect:false});
    expect(f.editor.querySelector('[data-work-resource]')).not.toBeNull();
});
it('re-reads associations once when the item links change while an older read is pending', async () => {
    const f=await fixture(), gate=deferred<any[]>();
    const resource=(id:string)=>({id,kind:'opaque',title:id,location:'/'+id,version:'',state:'associated',reasons:[],properties:[],canCleanup:false});
    f.service.workResources=vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue([resource('new-tree')]);
    const view=await f.mount(),section=f.editor.querySelector<HTMLDetailsElement>('[data-work-resources]')!;
    section.open=true;section.dispatchEvent(new Event('toggle'));
    await vi.waitFor(()=>expect(f.service.workResources).toHaveBeenCalledOnce());
    await f.service.execute('work',{operationId:'associate-resource',expectedRevision:(await f.service.read('work')).revision,
        command:{type:'link-reference',itemId:'one',reference:{system:'external-resource',id:'new-tree'}}});
    view.invalidateFromEvents();
    await vi.waitFor(()=>expect(section.dataset.associationRevision).toBe('1'));
    gate.resolve([resource('old-tree')]);
    await vi.waitFor(()=>expect(f.editor.querySelector('[data-work-resource="new-tree"]')).not.toBeNull());
    expect(f.editor.querySelector('[data-work-resource="old-tree"]')).toBeNull();
    expect(f.service.workResources).toHaveBeenCalledTimes(2);
    expect(f.service.workResources).toHaveBeenLastCalledWith('work','one',{inspect:false});
});
it('copies saved workspace fields and checks cleanup only after an explicit request', async () => {
    const f = await fixture(), writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', Object.create(navigator, {clipboard: {value: {writeText}}}));
    f.service.workResources = vi.fn(async () => [{id:'tree',kind:'opaque',title:'work/one',location:'/retained',version:'',state:'associated',reasons:[],properties:[],canCleanup:false}]);
    await f.mount(); const section=f.editor.querySelector<HTMLDetailsElement>('[data-work-resources]')!;
    section.open=true; section.dispatchEvent(new Event('toggle'));
    await vi.waitFor(()=>expect(section.querySelector('[data-work-resource]')).not.toBeNull());
    section.querySelector<HTMLButtonElement>('[data-copy="/retained"]')!.click();
    await vi.waitFor(()=>expect(writeText).toHaveBeenCalledExactlyOnceWith('/retained'));
    await vi.waitFor(()=>expect(f.editor.hasAttribute('aria-busy')).toBe(false));
    expect(f.service.workResources).toHaveBeenCalledTimes(1);
    section.querySelector<HTMLButtonElement>('[data-action="inspect-work-resources"]')!.click();
    await vi.waitFor(()=>expect(f.service.workResources).toHaveBeenCalledTimes(2));
    expect(f.service.workResources).toHaveBeenLastCalledWith('work','one',{inspect:true});
});
it('shows continuation only when the host provides an eligible predecessor', async () => {
    const f = await fixture();
    f.service.executionSession = vi.fn(async () => ({history: [], continuation: {previousDispatchId: 'failed'}}));
    await f.mount();
    await vi.waitFor(() => expect(f.editor.querySelector('[data-action=continue-execution]')?.getAttribute('data-dispatch')).toBe('failed'));
});
