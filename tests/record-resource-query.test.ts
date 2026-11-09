import {afterEach,expect,it} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule,SeqKanbanStore} from '../src';
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
it('filters associated resources before pagination, preserves unique records and binds cursors to the filter',async()=>{
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());
 const service=createKanbanModule({store:await SeqKanbanStore.open(await manager.openFileSystem('/')),actor:{kind:'human',id:'owner'},authorize:async()=>{},log(){}});
 await service.create({id:'b',title:'Board',scope:{kind:'system'},members:[{kind:'human',id:'owner',responsibility:'Review',roles:['coordinator','reviewer']}]});
 const resource=(id:string)=>({system:'projects',id});
 for(const [id,ids] of [['unrelated',['three']],['shared',['one','two']],['secondary',['two']],['primary',['one']]] as Array<[string,string[]]>) {
  await service.execute('b',{operationId:id,expectedRevision:(await service.read('b')).revision,command:{type:'append-record',record:{id,kind:'decision',title:id,content:'Scope',rationale:'Acceptance',itemIds:[],sources:[],externalRefs:ids.map(resource)}}});
 }
 const revision=(await service.read('b')).revision;
 const first=await service.records('b',{kind:'decision',resource:resource('two'),limit:1});
 expect(first.total).toBe(2);expect(first.items).toHaveLength(1);expect(first.nextCursor).toBeDefined();
 const second=await service.records('b',{kind:'decision',resource:resource('two'),limit:1,cursor:first.nextCursor});
 expect(new Set([...first.items,...second.items].map(row=>row.id))).toEqual(new Set(['shared','secondary']));expect(second.nextCursor).toBeUndefined();
 await expect(service.records('b',{kind:'decision',resource:resource('one'),limit:1,cursor:first.nextCursor})).rejects.toMatchObject({code:'CURSOR_STALE'});
 expect((await service.records('b',{resource:resource('one')})).items.map(row=>row.id).sort()).toEqual(['primary','shared']);
 expect((await service.records('b')).total).toBe(4);expect((await service.read('b')).revision).toBe(revision);
 await expect(service.records('b',{resource:{system:'projects',id:''}})).rejects.toBeDefined();
});
