import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal} from '../src/runtime/automation-journal';
import {analyzeItem} from '../src/runtime/analysis';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0)) await close();});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose());
    const journal = new KanbanAutomationJournal(await manager.openFileSystem('/')); await journal.open();
    const item = {id: 'task', revision: 1, title: 'Work', status: 'backlog'}, board = {id: 'board', revision: 1, automation: {enabled: true}, items: [item]};
    const port = {prepare: vi.fn(async ({id}: {id: string}) => ({id})), prepareExecution: vi.fn(async () => {}), submit: vi.fn(async () => {}),
        inspect: vi.fn(async () => ({state: 'running' as const}))};
    const service = {read: async () => board, execute: vi.fn(async () => {})};
    const run = () => analyzeItem({journal, port, active: () => true, log: vi.fn(), retryable: error => (error as {code?: string}).code === 'EIO'}, board as never, item as never, {}, service as never);
    return {journal, port, run};
}
it('retries preparation with its original identity before admission', async () => {
    const f = await fixture(); f.port.prepareExecution.mockRejectedValueOnce(Object.assign(new Error('unavailable'), {code: 'EIO'}));
    await expect(f.run()).rejects.toMatchObject({code: 'EIO'}); await f.run();
    expect(f.port.prepare).toHaveBeenCalledOnce(); expect(f.port.prepareExecution).toHaveBeenCalledTimes(2);
    expect(f.port.prepareExecution.mock.calls[0]).toEqual(f.port.prepareExecution.mock.calls[1]); expect(f.port.submit).toHaveBeenCalledOnce();
});
it('never resubmits an unknown admission when later observations recover', async () => {
    const f = await fixture(); f.port.submit.mockRejectedValueOnce(Object.assign(new Error('response lost'), {code: 'EIO'}));
    await f.run(); await f.run(); await f.run();
    expect(f.port.submit).toHaveBeenCalledOnce(); expect(f.port.prepare).toHaveBeenCalledOnce(); expect(f.port.inspect).toHaveBeenCalledTimes(3);
});
