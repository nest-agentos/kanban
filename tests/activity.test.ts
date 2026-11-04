import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {SeqKanbanStore, type KanbanCommand} from '../src';
import {createKanbanActivityModule} from '../src/activity';
import {createKanbanSessionActivity} from '../src/session-activity';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close();});
it('avoids workflow and full catalog reads when an authorized page or task has no execution bindings', async () => {
    const page = {items: [{id: 'one'}], revision: 1, total: 1};
    const core = {query: vi.fn(async () => page), item: vi.fn(async () => ({item: {id: 'one'}})),
        catalog: vi.fn(async () => {throw new Error('Unnecessary catalog read');}), workflow: vi.fn(async () => {throw new Error('Unnecessary workflow read');})};
    const activity = createKanbanSessionActivity(core as never, undefined, vi.fn(), 'external-job');
    expect(await activity.queryActivity('board')).toEqual(page);
    expect(await activity.executionSession('board', 'one')).toEqual({history: []});
    expect(core.query).toHaveBeenCalledOnce(); expect(core.item).toHaveBeenCalledOnce();
    expect(core.catalog).not.toHaveBeenCalled(); expect(core.workflow).not.toHaveBeenCalled();
});
it('drains admitted resource observations before closing core queries and refuses new admissions', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose());
    const store = await SeqKanbanStore.open(await manager.openFileSystem('/'));
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;}), started = new Promise<void>(resolve => {entered = resolve;});
    const inspect = vi.fn(async (_board: unknown, sessionId: string) => {
        entered(); await gate;
        return {sessionId, resourceId:'/native/job-1',state: 'running' as const, observedAt: Date.now(), stale: false};
    });
    const service = createKanbanActivityModule({store, referenceSystem: 'external-job', actor: {kind: 'human', id: 'owner'},
        authorize: async () => {}, log: vi.fn(), executionSessions: {source: {authorizeBinding: async () => {}, inspect}}});
    await service.create({id: 'b', title: 'Work', scope: {kind: 'system'}, members: [{kind: 'human', id: 'owner', responsibility: 'Work'}]});
    const run = async (id: string, command: KanbanCommand) => service.execute('b', {operationId: id, expectedRevision: (await service.read('b')).revision, command});
    await run('create', {type: 'create-item', item: {id: 'i', title: 'Work', responsibility: 'Deliver', acceptance: 'Review'}});
    await run('link', {type: 'link-reference', itemId: 'i', reference: {system: 'external-job', id: 'job-1', revision: 'binding-1'}});
    const reading = service.queryActivity('b', {view: 'all'}); await started;
    let closed = false; const closing = service.quiesce().then(() => {closed = true;});
    await expect(service.read('b')).rejects.toMatchObject({code: 'SERVICE_STOPPING'});
    expect(closed).toBe(false); release();
    expect((await reading).items[0].execution).toMatchObject({sessionId: 'job-1',resourceId:'/native/job-1', state: 'running'});
    await closing; expect(closed).toBe(true);
    await expect(service.queryActivity('b')).rejects.toMatchObject({code: 'SERVICE_STOPPING'});
});
