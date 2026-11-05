import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {createKanban, SeqKanbanStore} from '@nestos/kanban';

const {manager} = await createVFS({rootBackend: new MemoryBackend()});
const store = await SeqKanbanStore.open(await manager.openFileSystem('/'));
// The demo trusts its single in-memory user. Production hosts enforce authorization here.
const api = createKanban({store, actor: {kind: 'human', id: 'owner'}, authorize: async () => {}});
try {
    await api.boards.create({id: 'research', title: 'Research', scope: {kind: 'system'},
        members: [{kind: 'human', id: 'owner', responsibility: 'Research'}],
        policy: {requireEstimate: false, review: 'assignee'}});
    await api.execute('research', {operationId: 'create', expectedRevision: (await api.boards.get('research')).revision,
        command: {type: 'create-item', stage: 'open', item: {id: 'experiment', title: 'Experiment', responsibility: 'Collect evidence', acceptance: 'Evidence recorded'}}});
    await api.execute('research', {operationId: 'claim', expectedRevision: (await api.boards.get('research')).revision,
        command: {type: 'claim', itemId: 'experiment'}});
    const item = (await api.items.get('research', 'experiment')).item;
    await api.execute('research', {operationId: 'submit', expectedRevision: (await api.boards.get('research')).revision,
        command: {type: 'submit', itemId: item.id, token: item.owner!.token, resultRef: 'lab:evidence'}});
    const delivered = (await api.items.get('research', 'experiment')).item;
    if (delivered.status !== 'completed') throw new Error('Expected a completed item');
    console.log(JSON.stringify({id: delivered.id, status: delivered.status}));
} finally {await api.dispose(); await manager.dispose();}
