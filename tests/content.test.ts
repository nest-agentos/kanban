import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {SeqKanbanStore, installKanbanContent, inspectKanbanContent} from '../src/storage';
import {KanbanError} from '../src';
import type {KanbanContent} from '../src/contracts';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0)) await close();});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), store = await SeqKanbanStore.open(fs);
    const content: KanbanContent = {id: 'starter', version: 1, board: {id: 'research', title: 'Research', scope: {kind: 'collection', namespace: 'lab', id: 'research'},
        members: [{kind: 'human', id: 'owner', responsibility: 'Research'}]},
        items: [{command: {type: 'create-item', item: {id: 'question', title: 'Question', responsibility: 'Investigate', acceptance: 'Evidence'}}}]};
    const options = {store, actor: {kind: 'human' as const, id: 'owner'}, content, operationId: 'install-v1', authorize: vi.fn(async () => {}), log: vi.fn()};
    return {fs, store, content, options};
}
it('installs versioned content once and keeps imported identity history inside the owned storage boundary', async () => {
    const f = await fixture();
    expect(await installKanbanContent(f.options)).toEqual({changed: true, created: 1});
    const first = await f.store.read('research');
    expect(await installKanbanContent(f.options)).toEqual({changed: false, created: 0});
    expect(await f.store.read('research')).toEqual(first);
    expect(await inspectKanbanContent(f.store, f.content)).toEqual({version: 1, complete: true});
    f.content.version = 2;
    f.content.items.push({introduced: 2, command: {type: 'create-item', item: {id: 'experiment', title: 'Experiment', responsibility: 'Measure', acceptance: 'Verified'}}});
    await expect(installKanbanContent({...f.options, operationId: 'install-v2'})).resolves.toEqual({changed: true, created: 1});
    expect((await f.store.read('research'))!.board.items.map(item => item.id)).toEqual(['question', 'experiment']);
});
it('requires explicit import authorization before persisting content or accepting imported authors', async () => {
    const f = await fixture(), update = vi.spyOn(f.store, 'update');
    const authorize = vi.fn(async () => {throw new KanbanError('FORBIDDEN');});
    await expect(installKanbanContent({...f.options, authorize})).rejects.toMatchObject({code: 'FORBIDDEN'});
    expect(authorize.mock.calls[0][0]).toMatchObject({action: 'install-content', actor: {id: 'owner'}, board: {id: 'research'}});
    expect(update).not.toHaveBeenCalled(); expect(await f.store.read('research')).toBeNull();
});
it('rolls back all content and its installation receipt on domain validation failure, without logging content', async () => {
    const f = await fixture();
    f.content.items.push({command: {type: 'create-item', item: {id: 'bad', title: 'private content', responsibility: '', acceptance: 'Evidence'}}});
    await expect(installKanbanContent(f.options)).rejects.toMatchObject({code: 'INVALID_TEXT'});
    expect(await f.store.read('research')).toBeNull();
    expect(await f.fs.meta.seq!.getEntry('/kanban/boards.seq', 'receipt/research/install-v1')).toBeNull();
    expect(f.options.log).toHaveBeenLastCalledWith(expect.objectContaining({operationId: 'install-v1', stage: 'content.install', result: 'failure', code: 'INVALID_TEXT'}));
    expect(JSON.stringify(f.options.log.mock.calls)).not.toContain('private content');
});
