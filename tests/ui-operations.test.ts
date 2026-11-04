// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule, SeqKanbanStore} from '../src';
import {KanbanWorkbench} from '../src/ui';
import type {KanbanClient, KanbanItemOperations} from '../src/contracts';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close(); document.body.replaceChildren();});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose());
    const store = await SeqKanbanStore.open(await manager.openFileSystem('/'));
    const service: KanbanClient = createKanbanModule({store, actor: {kind: 'human', id: 'owner'}, authorize: async () => {}, log: vi.fn()});
    await service.create({id: 'work', title: 'Work', scope: {kind: 'system'}, members: [{kind: 'human', id: 'owner', responsibility: 'Manage'}]});
    await service.execute('work', {operationId: 'create', expectedRevision: 1, command: {type: 'create-item', item: {id: 'one', title: 'Task', responsibility: 'Work', acceptance: 'Reviewed'}}});
    const editor = document.createElement('main'); document.body.append(editor); const openSession = vi.fn(async () => {});
    let state: KanbanItemOperations = {revision: 'revision', operations: [{id: 'analyze', label: 'Analyze original', state: 'ready', enabled: true, openSessionOnRun: true},
        {id: 'merge', label: 'Merge', state: 'waiting-confirmation', enabled: true, confirmation: 'I approve this plan', fields: [{id: 'confirmed', label: '<file.ts>', choices: [{id: 'keep', label: 'Keep <target>'}, {id: 'combine', label: 'Combine'}]}]}]};
    service.itemOperations = vi.fn(async () => state); service.runItemOperation = vi.fn(async (_board, request) => ({...state, operations: state.operations.map(operation => operation.id === request.action ? {...operation, state: 'running', sessionId: '/native/original'} : operation)}));
    service.bindItemOperation = vi.fn(async () => state);
    const view = new KanbanWorkbench({editor, service, presentation: {text: key => key, icons: {refreshView: '', more: '', close: ''}}, itemOperationsAvailable: () => true,
        selected: vi.fn(), openSession, initialResource: '/board/work/one'}); closes.push(() => view.destroy()); await view.start();
    await vi.waitFor(() => expect(editor.querySelector('[data-form=item-operation]')).not.toBeNull());
    return {editor, service, view, openSession, setState: (value: KanbanItemOperations) => {state = value;}};
}
it('submits an original-session analysis from the UI and opens that same Session', async () => {
    const f = await fixture(); f.editor.querySelector<HTMLButtonElement>('[data-operation=analyze] button')!.click();
    await vi.waitFor(() => expect(f.service.runItemOperation).toHaveBeenCalledOnce());
    expect(f.service.runItemOperation).toHaveBeenCalledWith('work', expect.objectContaining({itemId: 'one', action: 'analyze', expectedRevision: 'revision', operationId: expect.any(String)}));
    expect(f.openSession).toHaveBeenCalledWith('/native/original'); expect(f.editor.querySelector('[data-operation-id=analyze]')?.textContent).toContain('operationState.running');
});
it('requires explicit conflict and confirmation choices and preserves draft choices on polling', async () => {
    const f = await fixture(), form = f.editor.querySelector<HTMLFormElement>('[data-operation=merge]')!;
    const select = form.querySelector<HTMLSelectElement>('select')!;
    expect(select.value).toBe(''); expect(select.name).toBe('choice-confirmed'); expect(form.reportValidity()).toBe(false);
    expect(form.querySelector('file')).toBeNull(); select.value = 'combine'; select.dispatchEvent(new Event('input', {bubbles: true}));
    await (f.view as any).refreshActivity((f.view as any).generation); expect(f.editor.querySelector('[name=choice-confirmed]')).toBe(select); expect(select.value).toBe('combine');
    const check = form.querySelector<HTMLInputElement>('[name=confirmed]')!; check.checked = true; form.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() => expect(f.service.runItemOperation).toHaveBeenCalledOnce());
    expect(f.service.runItemOperation).toHaveBeenCalledWith('work', expect.objectContaining({action: 'merge', confirmed: true, selections: {confirmed: 'combine'}}));
});
it('keeps initial render independent of the operation query and allows explicit refresh', async () => {
    const f = await fixture(); f.setState({revision: 'fresh', operations: [{id: 'deploy', label: 'Replace', state: 'unavailable', enabled: false, configurable: true}], targets: []});
    f.editor.querySelector<HTMLButtonElement>('[data-action=refresh-item-operations]')!.click();
    await vi.waitFor(() => expect(f.editor.querySelector('[data-operation=deploy]')).not.toBeNull());
    expect(f.editor.querySelector<HTMLButtonElement>('[data-operation=deploy] button')!.disabled).toBe(true);
    expect(f.editor.textContent).toContain('operationNoFlows'); expect(f.service.runItemOperation).not.toHaveBeenCalled();
});
it('binds a published Flow through the configuration form without starting it', async () => {
    const f = await fixture(), reference = {system: 'project-flow', id: 'replace', revision: 'frozen'};
    f.setState({revision: 'configure', operations: [{id: 'deploy', label: 'Replace', state: 'unavailable', enabled: false, configurable: true}], targets: [{label: 'Project replace', reference}]});
    f.editor.querySelector<HTMLButtonElement>('[data-action=refresh-item-operations]')!.click();
    await vi.waitFor(() => expect(f.editor.querySelector('[data-form=operation-binding]')).not.toBeNull());
    const form = f.editor.querySelector<HTMLFormElement>('[data-form=operation-binding]')!;
    (form.parentElement as HTMLDetailsElement).open = true;
    const select = form.querySelector<HTMLSelectElement>('select')!; select.value = JSON.stringify(reference); select.dispatchEvent(new Event('input', {bubbles: true}));
    form.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() => expect(f.service.bindItemOperation).toHaveBeenCalledWith('work', expect.objectContaining({action: 'deploy', itemId: 'one', expectedRevision: 'configure', target: reference})));
    expect(f.service.runItemOperation).not.toHaveBeenCalled();
});
