import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {createKanbanModule, SeqKanbanStore} from '@itookit/kanban';
import {createKanbanExecutionBridge} from '@itookit/kanban/execution';

// No application runtime, Session, Flow, Kernel or model is needed.
const {manager} = await createVFS({rootBackend: new MemoryBackend()});
const fs = await manager.openFileSystem('/');
const store = await SeqKanbanStore.open(fs);
const api = (id: string) => createKanbanModule({store, actor: {kind: 'service', id},
    authorize: async () => {}, log: event => {if (event.result === 'failure') console.error(event);}});
const coordinator = api('coordinator'), worker = api('worker');
await coordinator.create({id: 'research', title: 'Independent research board', scope: {kind: 'collection', namespace: 'lab', id: 'research'},
    members: [{kind: 'service', id: 'coordinator', responsibility: 'Coordinate', roles: ['coordinator', 'reviewer']},
        {kind: 'service', id: 'worker', responsibility: 'Research', roles: ['worker']}],
    policy: {requireEstimate: false, review: 'assignee'}});
await coordinator.execute('research', {operationId: 'publish-research', expectedRevision: 1, command: {type: 'publish-plan', plan: {
    schema: 'kanban.plan/1', id: 'plan', revision: 1, sealed: true,
    items: ['collect', 'evaluate'].map((id, index) => ({id, title: id, responsibility: 'Produce evidence', acceptance: 'Evidence verified',
        assignee: {kind: 'service', id: 'worker'}, dependsOn: index ? ['collect'] : []})),
}}});
const bridge = await createKanbanExecutionBridge({fs, directory: '/execution', boardId: 'research', service: coordinator,
    worker: async () => worker, autoDispatch: true, authorize: async () => {}, log: () => {}, executor: {
        prepare: async dispatch => ({id: dispatch.id}),
        start: async () => ({outcome: 'succeeded'}),
        inspect: async () => ({outcome: 'unknown', code: 'RECEIPT_UNAVAILABLE'}),
    }});
try {
    await bridge.tick(); await bridge.tick();
    console.log(JSON.stringify({completedPlans: (await coordinator.workflow('research')).completedPlans,
        items: (await coordinator.query('research', {view: 'all'})).items.map(item => ({id: item.id, status: item.status}))}));
} finally {
    await bridge.quiesce(); await coordinator.quiesce(); await worker.quiesce(); await manager.dispose();
}
