import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {createKanbanModule, SeqKanbanStore, type KanbanCommand} from '../src';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0)) await close();});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose());
    const store = await SeqKanbanStore.open(await manager.openFileSystem('/'));
    const verifyDeletion = vi.fn(async () => {}), options = {store, actor: {kind: 'human' as const, id: 'admin'}, authorize: async () => {}, log: vi.fn(), verifyDeletion};
    const service = createKanbanModule(options);
    await service.create({id: 'board', title: 'Board', scope: {kind: 'system'}, members: [{kind: 'human', id: 'admin', responsibility: 'Manage', roles: ['coordinator', 'worker']}], policy: {requireEstimate: false}});
    let index = 0;
    const run = async (command: KanbanCommand) => service.execute('board', {operationId: 'operation-' + ++index, expectedRevision: (await service.read('board')).revision, command});
    return {service, store, options, verifyDeletion, run};
}
it('deletes the logical resource, persists audit and associations, and prevents resurrection after reopening', async () => {
    const f = await fixture();
    await f.run({type: 'create-item', item: {id: 'task', title: 'Task', responsibility: 'Work', acceptance: 'Done', externalRefs: [{system: 'fixture', id: 'resource'}]}});
    const previous = await f.service.read('board'); await f.run({type: 'delete-board'});
    expect(await f.service.catalog()).toEqual([]); expect(await f.service.list()).toEqual([]);
    const reopened = createKanbanModule(f.options), board = await reopened.read('board');
    expect(board.deletedAt).toBeTypeOf('number'); expect(board.items).toEqual(previous.items);
    expect((await reopened.events('board')).at(-1)?.kind).toBe('delete-board');
    await expect(f.run({type: 'scan'})).rejects.toMatchObject({code: 'BOARD_DELETED'});
    await expect(reopened.create({id: 'board', title: 'New', scope: {kind: 'system'}, members: (await reopened.read('board')).members})).rejects.toMatchObject({code: 'IDEMPOTENCY_CONFLICT'});
    await reopened.scan(); expect((await reopened.read('board')).revision).toBe(board.revision);
});
it('blocks active responsibility and host uncertainty without changing state', async () => {
    const f = await fixture();
    await f.run({type: 'create-item', item: {id: 'task', title: 'Task', responsibility: 'Work', acceptance: 'Done'}, stage: 'open'});
    await f.run({type: 'claim', itemId: 'task'});
    await expect(f.run({type: 'delete-board'})).rejects.toMatchObject({code: 'BOARD_EXECUTION_ACTIVE'});
    expect(await f.service.catalog()).toHaveLength(1);
    f.verifyDeletion.mockRejectedValueOnce(Object.assign(new Error('Unknown'), {code: 'BOARD_SESSION_UNSETTLED'}));
    await expect(f.run({type: 'delete-board'})).rejects.toMatchObject({code: 'BOARD_SESSION_UNSETTLED'});
});
it('rechecks revision after host verification and requires a human coordinator', async () => {
    const f = await fixture();
    f.verifyDeletion.mockImplementationOnce(async () => {await f.run({type: 'register-session', sessionId: 'session', role: 'observer', subscribed: false});});
    await expect(f.run({type: 'delete-board'})).rejects.toMatchObject({code: 'REVISION_CONFLICT'});
    const other = createKanbanModule({...f.options, actor: {kind: 'human', id: 'other'}});
    await expect(other.execute('board', {operationId: 'other-delete', expectedRevision: (await other.read('board')).revision, command: {type: 'delete-board'}})).rejects.toMatchObject({code: 'COORDINATOR_REQUIRED'});
});
