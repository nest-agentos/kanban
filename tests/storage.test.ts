import {afterEach, expect, it} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {SeqKanbanStore, createKanbanModule, type KanbanState} from '../src';
import {ConditionalKanbanStore} from '../src/storage';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const dispose of cleanup.splice(0)) await dispose();});
const path = '/var/lib/kanban/boards.seq';
function initial(): KanbanState {
    return {schema:1, sequence:0,events:[],escalations:[],board:{id:'b',revision:1,items:[
        {id:'one',participants:[],status:'backlog',revision:1,createdAt:1,updatedAt:1,title:'One',responsibility:'x'.repeat(6000),acceptance:'y'.repeat(6000)},
        {id:'two',participants:[],status:'backlog',revision:1,createdAt:1,updatedAt:1,title:'Two',responsibility:'short',acceptance:'short'},
    ]} as KanbanState['board']};
}
async function fixture() {
    const {manager} = await createVFS({rootBackend:new MemoryBackend()}); cleanup.push(()=>manager.dispose());
    const fs = await manager.openFileSystem('/'), store = await SeqKanbanStore.open(fs, '/var/lib/kanban');
    return {fs,store};
}
it('splits rows, externalizes large bodies and only updates the changed row', async () => {
    const {fs,store} = await fixture(); const state = initial();
    await store.update('b','seed','private-request-body',()=>state);
    const root = JSON.parse((await fs.meta.seq!.getEntry(path,'board/b'))!);
    expect(root.layout).toBe(2); expect(root.state.board.items).toEqual([]);
    const first = (await fs.meta.seq!.getEntry(path,'item/b/one'))!;
    expect(JSON.parse(first)).toMatchObject({body:'kanban-body/v1',bytes:expect.any(Number)});
    expect(first).not.toContain('xxxx');
    expect(await fs.meta.seq!.getEntry(path,'receipt/b/seed')).toMatch(/^sha256:v1:[a-f0-9]{64}$/);
    expect((await store.read('b'))!.board.items).toEqual(state.board.items);
    await store.update('b','edit','edit',current=>{current!.board.items[1].title='Changed';current!.board.revision++;return current!;});
    expect(await fs.meta.seq!.getEntry(path,'item/b/one')).toBe(first);
    expect(JSON.parse((await fs.meta.seq!.getEntry(path,'item/b/two'))!).title).toBe('Changed');
    expect((await SeqKanbanStore.open(fs, '/var/lib/kanban').then(store=>store.read('b')))!.board.items[0].responsibility).toHaveLength(6000);
});
it('reads legacy snapshots and receipts, migrating only on a successful new commit', async () => {
    const {fs,store} = await fixture(); const state = initial();
    await fs.meta.seq!.setEntries(path,{'board/b':JSON.stringify(state),'index':'["b"]','receipt/b/legacy':'old-fingerprint'});
    expect(await store.read('b')).toEqual(state);
    await store.update('b','legacy','old-fingerprint',()=>{throw new Error('must not replay');});
    expect(JSON.parse((await fs.meta.seq!.getEntry(path,'board/b'))!).layout).toBeUndefined();
    await store.update('b','new','new',current=>{current!.board.revision++;return current!;});
    expect(JSON.parse((await fs.meta.seq!.getEntry(path,'board/b'))!).layout).toBe(2);
    await expect(store.update('b','legacy','changed',()=>state)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
});
it('never commits a body reference when content publication cannot be confirmed', async () => {
    const {fs,store} = await fixture();
    const failedStore = await SeqKanbanStore.open(fs, '/var/lib/kanban', {read:async()=>null, write:async()=>{throw Object.assign(new Error('disk full'),{code:'ENOSPC'});}});
    await expect(failedStore.update('b','seed','seed',()=>initial())).rejects.toMatchObject({code:'ENOSPC'});
    expect(await fs.meta.seq!.getEntry(path,'board/b')).toBeNull();
    expect(await fs.meta.seq!.getEntry(path,'receipt/b/seed')).toBeNull();
    await store.update('b','seed','seed',()=>initial());
    expect((await store.read('b'))!.board.items).toHaveLength(2);
});
it('detects missing and corrupted external bodies instead of returning partial board state', async () => {
    const {fs,store} = await fixture(); await store.update('b','seed','seed',()=>initial());
    const ref = JSON.parse((await fs.meta.seq!.getEntry(path,'item/b/one'))!);
    await fs.meta.assets.putAsset(path,`${ref.sha256}.json`,new TextEncoder().encode('tampered').buffer);
    await expect(store.read('b')).rejects.toMatchObject({code:'BODY_INTEGRITY'});
    await fs.meta.assets.deleteAsset(path,`${ref.sha256}.json`);
    await expect(store.read('b')).rejects.toMatchObject({code:'BODY_MISSING'});
});
it('preserves a single commit when two instances prepare the same operation concurrently', async () => {
    const {fs,store} = await fixture(), second = await SeqKanbanStore.open(fs);
    const results = await Promise.all([store.update('b','same','same',()=>initial()),second.update('b','same','same',()=>initial())]);
    expect(results[0].board.revision).toBe(results[1].board.revision);
    expect((await store.read('b'))!.board.items).toHaveLength(2);
});
it('remote queries never request unrelated boards, events or receipts and send only changed rows', async () => {
    const entries = new Map<string, unknown>(), selections: string[][] = [], mutations: string[][] = []; let revision = 0;
    const client = {
        query: async (_path: string, selection: {keys: string[];expectedRevision?:string}) => {
            if (selection.expectedRevision) expect(selection.expectedRevision).toBe(String(revision));
            selections.push(selection.keys);
            return {revision:revision ? String(revision):null,next:null,entries:selection.keys.filter(key=>entries.has(key)).map(key=>({key,value:entries.get(key)}))};
        },
        transaction: async (_path: string, expected: string | null, changes: Array<{action:string;key:string;value?:unknown}>)=> {
            expect(expected).toBe(revision ? String(revision):null); mutations.push(changes.map(row=>row.key));
            for (const row of changes) if (row.action==='delete') entries.delete(row.key); else entries.set(row.key,row.value);
            return {revision:String(++revision)};
        },
    };
    const store = new ConditionalKanbanStore(client as never,async()=>{});
    await store.update('b','seed','seed',()=>initial());
    entries.set('event/other/0000000000000001','private-history'); entries.set('board/other','private-board');
    await store.update('b','edit','edit',state=>{state!.board.items[1].title='Changed';state!.board.revision++;return state!;});
    expect(mutations.at(-1)).toEqual(['item/b/two','board/b','receipt/b/edit']);
    expect(selections.flat().some(key=>key.includes('other'))).toBe(false);
    expect((await store.read('b'))!.board.items[1].title).toBe('Changed');
});

it('serves summary indexes without loading or depending on external bodies', async () => {
    const {fs,store} = await fixture(); await store.update('b','seed','seed',()=>initial());
    const ref = JSON.parse((await fs.meta.seq!.getEntry(path,'item/b/one'))!);
    await fs.meta.assets.deleteAsset(path,`${ref.sha256}.json`);
    const view = await store.view('b');
    expect(view!.items.map(item=>item.title)).toEqual(['One','Two']);
    expect(view!.state.board.items).toEqual([]); expect(JSON.stringify(view)).not.toContain('xxxx');
    const service = createKanbanModule({store, actor:{kind:'human',id:'user'},authorize:async()=>{},log:()=>{}});
    expect((await service.catalog())[0].items).toEqual([{id:'one',title:'One',number:1},{id:'two',title:'Two',number:2}]);
    expect(await service.events('b')).toEqual([]);
    await expect(store.read('b')).rejects.toMatchObject({code:'BODY_MISSING'});
});

it('rejects mixed remote revisions while hydrating rows, without publishing another transaction', async () => {
    const data = new Map<string,unknown>(); let revision = 0, stale = false, writes = 0;
    const client = {
        query: async (_path:string, selection:{keys:string[];expectedRevision?:string}) => {
            if (stale && selection.expectedRevision) throw Object.assign(new Error('stale'),{code:'ECONFLICT'});
            return {revision:revision ? String(revision):null,next:null,entries:selection.keys.filter(key=>data.has(key)).map(key=>({key,value:data.get(key)}))};
        },
        transaction: async (_path:string,_expected: string|null,changes:Array<{action:string;key:string;value:unknown}>)=> {
            writes++; for(const row of changes) data.set(row.key,row.value);return {revision:String(++revision)};
        },
    };
    const store = new ConditionalKanbanStore(client as never,async()=>{});
    await store.update('b','seed','seed',()=>initial()); stale=true;
    await expect(store.read('b')).rejects.toMatchObject({code:'REVISION_CONFLICT'});expect(writes).toBe(1);
});

it('retains the concrete remote body-integrity error category', async () => {
    const client = {
        query:async()=>({revision:'r1',next:null,entries:[{key:'archive/b/item',value:JSON.stringify({body:'kanban-body/v1',sha256:'a'.repeat(64),bytes:8193})}]}),
        readBody:async()=>{throw Object.assign(new Error('remote integrity'),{remoteCode:'SEQ_BODY_INTEGRITY'});},
        writeBody:async()=>{},transaction:async()=>({revision:'r2'}),
    };
    const store = new ConditionalKanbanStore(client as never,async()=>{});
    await expect(store.archived('b','item')).rejects.toMatchObject({code:'BODY_INTEGRITY'});
});

it('reads a 500-event page through bounded key batches', async () => {
    const batches: string[][] = [];
    const store = new ConditionalKanbanStore({query:async (_path:string, selection:{keys:string[]})=> {
        batches.push(selection.keys); return {revision:'r',next:null,entries:selection.keys.map(key=>({key,value:JSON.stringify({sequence:Number(key.split('/').at(-1))})}))};
    }} as never,async()=>{});
    const events = await store.events('b',0,500,490);
    expect(batches.map(batch=>batch.length)).toEqual([256,234]);expect(events).toHaveLength(490);
    expect(events[0].sequence).toBe(1);expect(events.at(-1)!.sequence).toBe(490);
});
