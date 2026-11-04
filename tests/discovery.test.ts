import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {createKanbanModule, SeqKanbanStore} from '../src';
import {createKanbanDiscovery, discoveryState} from '../src/discovery-entry';
import {DEFAULT_KANBAN_SCAN_POLICY, type KanbanScanInput, type KanbanDiscoveryChange} from '../src/contracts';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close();});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose());
    const store = await SeqKanbanStore.open(await manager.openFileSystem('/'));
    let now = 1000;
    const scope = {kind: 'collection' as const, namespace: 'support', id: 'requests'}, log = vi.fn();
    const service = createKanbanModule({store, actor: {kind: 'service', id: 'scanner'}, authorize: async () => {}, now: () => now, log});
    await service.create({id: 'b', title: 'Requests', scope, members: [{kind: 'service', id: 'worker', responsibility: 'Handle'}]});
    const session = {id: 'external-case', revision: 'v1', updatedAt: 900, idleSince: 900, activity: 'idle' as const, archived: false};
    const source = {scope, kind: 'local' as const, list: async () => [session], inspect: async () => session,
        read: async () => ({session, complete: true, messages: [{id: 'request', role: 'user' as const, text: 'private request'}]})};
    const run = vi.fn(async (_input: KanbanScanInput): Promise<KanbanDiscoveryChange[]> => [{action: 'create', itemId: 'case', title: 'Resolve request', responsibility: 'Investigate', acceptance: 'Verified',
        sources: [{sessionId: session.id, messageId: 'request', role: 'user', revision: session.revision}]}]);
    const options = {store, service, boardId: 'b', source, executor: {identity: 'external-analyzer', run}, log, now: () => now,
        authorize: async () => {}, policy: {...DEFAULT_KANBAN_SCAN_POLICY, idleMs: 100, connection: {kind: 'local' as const, connectionId: 'analysis', allowContentTransfer: false}}};
    return {store, service, source, run, options, tick: () => {now += 101;}};
}
it('submits collection-scoped proposals and checkpoints atomically without a mutable host extension', async () => {
    const f = await fixture(), scanner = createKanbanDiscovery(f.options);
    await scanner.scan(); f.tick(); await scanner.scan();
    expect((await f.service.item('b', 'case')).item.status).toBe('proposed');
    expect(discoveryState(await f.store.read('b'))?.checkpoints).toEqual({'external-case': 'v1'});
    const restarted = createKanbanDiscovery(f.options); await restarted.scan();
    expect(f.run).toHaveBeenCalledOnce();
});
it('rejects foreign scopes before reading or executing the source', async () => {
    const f = await fixture(); f.source.scope = {...f.source.scope, id: 'foreign'};
    await expect(createKanbanDiscovery(f.options).scan()).rejects.toMatchObject({code: 'SOURCE_PROJECT_MISMATCH'});
    expect(f.run).not.toHaveBeenCalled(); expect((await f.service.read('b')).items).toEqual([]);
});
it('keeps invalid evidence out of the board and checkpoint, logging only a classified failure', async () => {
    const f = await fixture(), scanner = createKanbanDiscovery(f.options);
    await scanner.scan(); f.tick();
    const normal = f.run.getMockImplementation()!;
    f.run.mockImplementationOnce(async input => (await normal(input)).map(change => ({...change, sources: [{sessionId: 'external-case', messageId: 'invented', role: 'user', revision: 'v1'}]})));
    await expect(scanner.scan()).rejects.toMatchObject({code: 'INVALID_SOURCE_REFERENCE'});
    expect((await f.service.read('b')).items).toEqual([]);
    expect(discoveryState(await f.store.read('b'))?.checkpoints).toEqual({});
    expect(JSON.stringify(f.options.log.mock.calls)).not.toContain('private request');
});
it('stops new scans and resets while draining an admitted source read', async () => {
    const f = await fixture();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;}), started = new Promise<void>(resolve => {entered = resolve;});
    const original = f.source.list;
    f.source.list = async () => {entered(); await gate; return original();};
    const scanner = createKanbanDiscovery(f.options), scanning = scanner.tick(); await started;
    let closed = false; const closing = scanner.quiesce().then(() => {closed = true;});
    await expect(scanner.scan()).rejects.toMatchObject({code: 'SERVICE_STOPPING'});
    await expect(scanner.reset('run')).rejects.toMatchObject({code: 'SERVICE_STOPPING'});
    expect(closed).toBe(false); release(); await scanning; await closing; expect(closed).toBe(true);
});
