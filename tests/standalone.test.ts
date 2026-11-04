import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {createKanban, createKanbanModule, SeqKanbanStore, type KanbanActor, type KanbanCommand} from '../src';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close();});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    closes.push(() => manager.dispose());
    const store = await SeqKanbanStore.open(await manager.openFileSystem('/'));
    const options = {store, actor: {kind: 'human' as const, id: 'owner'}, authorize: async () => {}, log: vi.fn()};
    return {store, options};
}
it('uses the grouped public API through delivery, archive, replay and reopen without any NestOS services', async () => {
    const {options} = await fixture(), api = createKanban(options);
    await api.boards.create({id: 'research', title: 'Research', scope: {kind: 'collection', namespace: 'lab', id: 'experiment'},
        members: [{kind: 'human', id: 'owner', responsibility: 'Research'}], policy: {requireEstimate: false, review: 'assignee'}});
    let serial = 0;
    const run = async (command: KanbanCommand) => api.execute('research', {operationId: `op-${++serial}`, expectedRevision: (await api.boards.get('research')).revision, command});
    await run({type: 'create-item', item: {id: 'experiment', title: 'Experiment', responsibility: 'Collect evidence', acceptance: 'Evidence recorded'}, stage: 'open'});
    await run({type: 'claim', itemId: 'experiment'});
    const item = (await api.items.get('research', 'experiment')).item;
    const request = {operationId: 'delivery', expectedRevision: (await api.boards.get('research')).revision,
        command: {type: 'submit' as const, itemId: item.id, token: item.owner!.token, resultRef: 'lab:evidence'}};
    await api.execute('research', request); await api.execute('research', request);
    expect((await api.events('research')).filter(event => event.kind === 'submit')).toHaveLength(1);
    await run({type: 'archive-items', itemIds: [item.id], reason: 'Retain evidence'});
    await api.quiesce();
    const reopened = createKanban(options);
    expect((await reopened.items.query('research', {view: 'archive'})).total).toBe(1);
    expect((await reopened.items.get('research', item.id)).item.resultRef).toBe('lab:evidence');
    const board = await reopened.boards.get('research');
    await reopened.execute(board.id, {operationId: 'restore', expectedRevision: board.revision, command: {type: 'restore-item', itemId: item.id}});
    expect((await reopened.items.get(board.id, item.id)).archive).toBeUndefined();
});
it('accepts generic Agent IDs while preserving optional execution identity fencing and host authorization', async () => {
    const {options} = await fixture();
    const actor: KanbanActor = {kind: 'agent', id: 'external-agent'};
    const api = createKanbanModule({...options, actor});
    await api.create({id: 'b', title: 'External agent', scope: {kind: 'system'}, members: [{kind: 'agent', id: 'external-agent', responsibility: 'Work'}], policy: {requireEstimate: false}});
    await api.execute('b', {operationId: 'create', expectedRevision: 1, command: {type: 'create-item', item: {id: 'i', title: 'Work', responsibility: 'Deliver', acceptance: 'Review'}, stage: 'open'}});
    const board = await api.execute('b', {operationId: 'claim', expectedRevision: (await api.read('b')).revision, command: {type: 'claim', itemId: 'i'}});
    const token = board.items[0].owner!.token;
    const otherExecution = createKanbanModule({...options, actor: {...actor, sessionId: 'other-execution'}});
    await expect(otherExecution.execute('b', {operationId: 'wrong-owner', expectedRevision: board.revision, command: {type: 'renew', itemId: 'i', token}})).rejects.toMatchObject({code: 'OWNER_MISMATCH'});
    const denied = createKanbanModule({...options, actor, authorize: async () => {throw Object.assign(new Error('secret content'), {code: 'FORBIDDEN'});}});
    await expect(denied.read('b')).rejects.toMatchObject({code: 'FORBIDDEN'});
    expect(JSON.stringify(options.log.mock.calls)).not.toContain('secret content');
});
