// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import type {KanbanSuggestionPage} from '@nestos/kanban/contracts';
import {KanbanSuggestionPicker} from '../src/ui';
import type {SuggestionField} from '../src/ui';
const log = vi.fn();
const presentation = {text: (key: string) => key, icons: {refreshView: '', more: '', close: ''}, log};
const cleanup: Array<() => void> = [];
afterEach(() => {cleanup.splice(0).forEach(close => close()); document.body.replaceChildren(); vi.restoreAllMocks();});
function fixture(config: Partial<SuggestionField> = {}, fetch = vi.fn(async (): Promise<KanbanSuggestionPage> => ({revision: 1, hasMore: false,
    items: [{id: 'one', label: 'Same title'}, {id: 'two', label: 'Same title'}]}))) {
    const form = document.createElement('form'), root = document.createElement('div'); form.append(root); document.body.append(form);
    const picker = new KanbanSuggestionPicker(root, {name: 'parentId', kind: 'parent', label: 'parent', ...config}, fetch, presentation); cleanup.push(() => picker.destroy());
    const input = root.querySelector<HTMLInputElement>('[role=combobox]')!;
    return {form, root, picker, input, fetch};
}
const type = (input: HTMLInputElement, text: string) => {input.value = text; input.dispatchEvent(new Event('input', {bubbles: true}));};
const key = (input: HTMLInputElement, value: string) => input.dispatchEvent(new KeyboardEvent('keydown', {key: value, bubbles: true, cancelable: true}));
it('selects by keyboard, displays labels and submits stable IDs even for duplicate titles', async () => {
    const f = fixture(); f.input.focus(); await vi.waitFor(() => expect(f.root.querySelectorAll('[role=option]')).toHaveLength(2));
    key(f.input, 'ArrowDown'); key(f.input, 'Enter');
    expect(f.input.value).toBe('Same title'); expect(new FormData(f.form).get('parentId')).toBe('two');
    expect(f.input.getAttribute('aria-expanded')).toBe('false');
    f.input.click(); await vi.waitFor(() => expect(f.input.getAttribute('aria-expanded')).toBe('true'));
    const bubbled = vi.fn(); f.root.addEventListener('keydown', bubbled); key(f.input, 'Escape');
    expect(f.input.getAttribute('aria-expanded')).toBe('false'); expect(bubbled).not.toHaveBeenCalled();
});
it('supports multi-select chips and removal without posting search text as an identity', async () => {
    const f = fixture({name: 'dependencies', kind: 'dependency', multiple: true, selected: [{id: 'one', label: 'Existing task'}]});
    f.input.focus(); await vi.waitFor(() => expect(f.root.querySelectorAll('[role=option]')).toHaveLength(1)); key(f.input, 'Enter');
    expect(new FormData(f.form).getAll('dependencies')).toEqual(['one', 'two']);
    f.root.querySelector<HTMLButtonElement>('[data-suggest-remove="one"]')!.click();
    expect(new FormData(f.form).getAll('dependencies')).toEqual(['two']);
    type(f.input, 'Unconfirmed query'); expect(f.input.checkValidity()).toBe(false); expect(new FormData(f.form).getAll('dependencies')).toEqual(['two']);
});
it('discards stale results and never changes a field after disposal', async () => {
    let resolveFirst!: (page: KanbanSuggestionPage) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => {resolveFirst = resolve;})).mockResolvedValue({revision: 2, hasMore: false, items: [{id: 'new', label: 'New match'}]});
    const f = fixture({}, fetch); f.input.focus(); type(f.input, 'New');
    await vi.waitFor(() => expect(f.root.textContent).toContain('New match'));
    resolveFirst({revision: 1, hasMore: false, items: [{id: 'old', label: 'Old match'}]}); await Promise.resolve();
    expect(f.root.textContent).not.toContain('Old match');
    f.picker.destroy(); type(f.input, 'Later'); await new Promise(resolve => setTimeout(resolve, 170)); expect(fetch).toHaveBeenCalledTimes(2);
});
it('allows new tag names, reports safe query failures and retries without losing input', async () => {
    log.mockClear();
    const fetch = vi.fn().mockRejectedValueOnce(Object.assign(new Error('PRIVATE_RESPONSE'), {code: 'EIO'})).mockResolvedValue({revision: 1, hasMore: false, items: [{id: 'New tag', label: 'New tag'}]});
    const f = fixture({name: 'area', kind: 'area', free: true}, fetch); f.input.value = 'New tag'; f.input.focus();
    await vi.waitFor(() => expect(f.root.textContent).toContain('suggestFailed'));
    expect(f.input.checkValidity()).toBe(true); expect(new FormData(f.form).get('area')).toBe('New tag');
    f.root.querySelector<HTMLButtonElement>('[data-suggest-retry]')!.click();
    await vi.waitFor(() => expect(f.root.querySelectorAll('[role=option]')).toHaveLength(1));
    expect(f.input.value).toBe('New tag'); expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_RESPONSE');
});
it('requires an explicit choice before using an unlisted session ID', async () => {
    const f = fixture({name: 'sessionId', kind: 'session', manual: true}, vi.fn(async () => ({revision: 1, hasMore: false, items: []})));
    type(f.input, 'native-session'); f.input.focus();
    await vi.waitFor(() => expect(f.root.querySelectorAll('[role=option]')).toHaveLength(1));
    expect(new FormData(f.form).get('sessionId')).toBe(''); key(f.input, 'Enter');
    expect(new FormData(f.form).get('sessionId')).toBe('native-session');
});

it('cannot select an old option while a new search is pending', async () => {
    const f = fixture(); f.input.focus(); await vi.waitFor(() => expect(f.root.querySelectorAll('[role=option]')).toHaveLength(2));
    type(f.input, 'A different task'); key(f.input, 'Enter');
    expect(new FormData(f.form).get('parentId')).toBe(''); expect(f.input.value).toBe('A different task'); expect(f.input.checkValidity()).toBe(false);
});
