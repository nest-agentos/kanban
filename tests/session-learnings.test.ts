import {afterEach, expect, it, vi} from 'vitest';
import {createHash} from 'node:crypto';
import type {KanbanRuntimeDiagnostic} from '../src/runtime/ports';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule} from '@nestos/kanban';
import {SeqKanbanStore} from '@nestos/kanban/storage';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {KanbanCommand} from '@nestos/kanban/contracts';
import {registerSessionLearnings,parseSessionLearnings,learningText} from '../src/runtime/integration';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close();});
const learning = {id: 'retry', itemId: 'one', event: 'Lost write receipt', handling: 'Inspect original operation',
    reason: 'Avoid duplicate effects', result: 'Recovered original receipt', conditions: 'Use stable operation IDs', evidence: []};

async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), store = await SeqKanbanStore.open(fs);
    const journal = new KanbanAutomationJournal(fs); await journal.open();
    const actor = {kind: 'human' as const, id: 'admin'};
    const service = createKanbanModule({store, actor, authorize: async () => {}});
    await service.create({id: 'board', title: 'Board', scope: {kind: 'system'}, policy: {requireEstimate: false, maxInProgressPerAssignee: 5},
        members: [{...actor, responsibility: 'Review', roles: ['coordinator', 'reviewer', 'worker']}]});
    let sequence = 0;
    const command = async (command: KanbanCommand) => service.execute('board', {operationId: 'op-' + ++sequence,
        expectedRevision: (await service.read('board')).revision, command});
    await command({type: 'publish-plan', plan: {schema: 'kanban.plan/1', id: 'plan', revision: 1, sealed: true,
        items: ['one', 'two', 'unrelated'].map(id => ({id, title: 'Same title', responsibility: 'Work', acceptance: 'Evidence', assignee: actor, dependsOn: [], outputs: []}))}});
    for (const id of ['one', 'two']) {
        await command({type: 'prepare-dispatch', itemId: id, dispatchId: 'dispatch-' + id});
        const dispatch = (await service.workflow('board')).dispatches['dispatch-' + id];
        await command({type: 'observe-execution', dispatchId: dispatch.id, fence: dispatch.fence, outcome: 'running', executionSessionId: 'session'});
        await command({type: 'link-reference', itemId: id, reference: {system: 'nestos-execution-session', id: 'session', revision: dispatch.id}});
    }
    const logs:KanbanRuntimeDiagnostic[]=[];
    const input = {digest:(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex'),diagnostic:(event:KanbanRuntimeDiagnostic)=>{logs.push(event);},boardId: 'board', sessionId: 'session', messageId: 'report', service, journal, payload: {learnings: [learning]}};
    return {input, service, journal, fs,logs};
}

it('registers concise source-linked records once across concurrency and journal recovery', async () => {
    const f = await fixture(), before = (await f.service.item('board', 'one')).item;
    await Promise.all([registerSessionLearnings(f.input), registerSessionLearnings(f.input)]);
    await registerSessionLearnings({...f.input, journal: new KanbanAutomationJournal(f.fs)});
    await registerSessionLearnings({...f.input, messageId: 'repeated-report'});
    const page = await f.service.records('board', {itemId: 'one'});
    expect(page.total).toBe(1);
    const record = await f.service.record('board', page.items[0].id);
    expect(record).toMatchObject({kind: 'log', rationale: learning.reason, sources: [{sessionId: 'session', messageId: 'report', role: 'assistant'}]});
    expect(record.content).toContain(learning.conditions);
    expect((await f.service.item('board', 'one')).item).toEqual(before);
});

it('writes nothing without experience or a formal execution source', async () => {
    const f = await fixture();
    await registerSessionLearnings({...f.input, payload: {}});
    await registerSessionLearnings({...f.input, payload: {learnings: []}});
    await registerSessionLearnings({...f.input, sessionId: undefined});
    expect((await f.service.records('board')).total).toBe(0);
});

it('assigns each learning only to its explicitly associated task', async () => {
    const f = await fixture();
    await registerSessionLearnings({...f.input, payload: {learnings: [learning, {...learning, itemId: 'two'}]}});
    expect((await f.service.records('board', {itemId: 'one'})).total).toBe(1);
    expect((await f.service.records('board', {itemId: 'two'})).total).toBe(1);
    await expect(registerSessionLearnings({...f.input, payload: {learnings: [{...learning, itemId: 'unrelated'}]}})).rejects.toMatchObject({code: 'LEARNING_TASK_NOT_ASSOCIATED'});
    expect((await f.service.records('board', {itemId: 'unrelated'})).total).toBe(0);
});

it('recovers an unknown write receipt with the original command identity', async () => {
    const f = await fixture(), execute = f.service.execute.bind(f.service);
    const spy = vi.spyOn(f.service, 'execute').mockImplementationOnce(async (board, request) => {
        await execute(board, request); throw Object.assign(Error('secret transport detail'), {code: 'EIO'});
    });
    await expect(registerSessionLearnings(f.input)).rejects.toMatchObject({code: 'EIO'});
    const logs = f.logs;
    expect(JSON.stringify(logs)).not.toContain('secret transport detail');
    expect(logs.at(-1)).toMatchObject({operation: 'kanban.learning', stage: 'persist', result: 'failure', code: 'EIO'});
    expect(await f.journal.find('learning-', row => (row as {state?: string}).state === 'pending')).toHaveLength(1);
    spy.mockRestore();
    await registerSessionLearnings({...f.input, journal: new KanbanAutomationJournal(f.fs)});
    expect((await f.service.records('board')).total).toBe(1);
    expect(await f.journal.find('learning-', row => (row as {state?: string}).state === 'pending')).toHaveLength(0);
});

it('strips credentials before persistence and rejects invented evidence or identity changes', async () => {
    const f = await fixture();
    await registerSessionLearnings({...f.input, payload: {learnings: [{...learning, handling: 'token=secret-value Bearer abc.def.xyz email@example.com'}]}});
    const record = await f.service.record('board', (await f.service.records('board')).items[0].id);
    expect(JSON.stringify(record)).not.toMatch(/secret-value|abc\.def\.xyz|email@example/);
    expect(JSON.stringify(f.logs)).not.toMatch(/secret-value|abc\.def\.xyz|email@example/);
    await expect(registerSessionLearnings(f.input)).rejects.toMatchObject({code: 'LEARNING_IDENTITY_CONFLICT'});
    await expect(registerSessionLearnings({...f.input, payload: {learnings: [{...learning, id: 'evidence', evidence: ['invented']}]}})).rejects.toMatchObject({code: 'LEARNING_EVIDENCE_MISSING'});
});

it('retains a failed write as pending and retries without changing the task outcome', async () => {
    const f = await fixture(), before = (await f.service.item('board', 'one')).item;
    const spy = vi.spyOn(f.service, 'execute').mockRejectedValueOnce(Object.assign(Error('private payload'), {code: 'ENOSPC'}));
    await expect(registerSessionLearnings(f.input)).rejects.toMatchObject({code: 'ENOSPC'});
    expect((await f.service.records('board')).total).toBe(0);
    expect((await f.service.item('board', 'one')).item).toEqual(before);
    spy.mockRestore(); await registerSessionLearnings(f.input);
    expect((await f.service.records('board')).total).toBe(1);
});

it('rejects empty, oversized and duplicate summaries', () => {
    expect(() => parseSessionLearnings({learnings: [{...learning, event: ''}]})).toThrow();
    expect(() => parseSessionLearnings({learnings: [{...learning, result: 'x'.repeat(1201)}]})).toThrow();
    expect(() => parseSessionLearnings({learnings: [learning, learning]})).toThrow();
});

it('redacts quoted credentials, private keys, JWTs and credential URLs', () => {
    const text = learningText('{"api_key":"private-value"} password=another-value Bearer bearer-value eyJhbGciOiJIUzI1NiJ9.payload.signature https://user:pass@example.test/path\n-----BEGIN PRIVATE KEY-----\nkey-body\n-----END PRIVATE KEY-----');
    expect(text).not.toMatch(/private-value|another-value|bearer-value|eyJhb|user:pass|key-body/);
});
