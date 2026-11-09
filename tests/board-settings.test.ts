import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule,SeqKanbanStore} from '../src';
const close:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const fn of close.splice(0))await fn();});
async function fixture(){const {manager}=await createVFS({rootBackend:new MemoryBackend()});close.push(()=>manager.dispose());const store=await SeqKanbanStore.open(await manager.openFileSystem('/'));const options={store,actor:{kind:'human' as const,id:'owner'},authorize:async()=>{},log:vi.fn()};const service=createKanbanModule(options);await service.create({id:'one',title:'One',scope:{kind:'system'},members:[{kind:'human',id:'owner',responsibility:'Manage',roles:['coordinator','reviewer','worker']}]});await service.create({id:'two',title:'Two',scope:{kind:'system'},members:[{kind:'human',id:'owner',responsibility:'Manage',roles:['coordinator','reviewer','worker']}]});return {service,options};}
it('persists host-defined settings independently per board with revision and operation identity checks',async()=>{
    const f=await fixture();const board=await f.service.read('one');const request={operationId:'settings',expectedRevision:board.revision,command:{type:'configure-board-settings' as const,settings:{hostTarget:'profile-a'}}};
    await f.service.execute('one',request);await f.service.execute('one',request);
    expect((await f.service.read('one')).settings).toEqual({hostTarget:'profile-a'});expect((await f.service.read('two')).settings).toBeUndefined();
    await expect(f.service.execute('one',{...request,operationId:'stale',command:{...request.command,settings:{hostTarget:'profile-b'}}})).rejects.toMatchObject({code:'REVISION_CONFLICT'});
    const reopened=createKanbanModule(f.options);expect((await reopened.read('one')).settings).toEqual({hostTarget:'profile-a'});
});
it('rejects malformed settings and non-human writes without changing the board',async()=>{
    const f=await fixture(),board=await f.service.read('one');
    for(const [index,settings]of [undefined,null,new Date(),new Map(),{value:42}].entries())await expect(f.service.execute('one',{operationId:'bad-'+index,expectedRevision:board.revision,command:{type:'configure-board-settings',settings:settings as never}})).rejects.toMatchObject({code:'INVALID_BOARD_SETTINGS'});
    const worker=createKanbanModule({...f.options,actor:{kind:'service',id:'worker'}});
    await expect(worker.execute('one',{operationId:'worker',expectedRevision:board.revision,command:{type:'configure-board-settings',settings:{hostTarget:'other'}}})).rejects.toMatchObject({code:'FORBIDDEN'});
    expect((await f.service.read('one')).settings).toBeUndefined();
});
