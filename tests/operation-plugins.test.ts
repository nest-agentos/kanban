import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal,createOperationPluginRegistry,type KanbanOperationPlugin,type KanbanRuntimeContext} from '../src/runtime/integration';
const close:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const fn of close.splice(0))await fn();});
async function fixture(){
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});close.push(()=>manager.dispose());
 const journal=new KanbanAutomationJournal(await manager.openFileSystem('/'));await journal.open();
 const context={journal,service:{read:async()=>({id:'board'}),item:async()=>({item:{id:'item'}})}} as unknown as KanbanRuntimeContext;
 const provider=()=>({itemOperations:vi.fn(async()=>({revision:'r1',operations:[{id:'publish',label:'Publish',state:'ready' as const,enabled:true}]})),runItemOperation:vi.fn(async()=>({revision:'r2',operations:[]})),scan:vi.fn(async()=>{}),quiesce:vi.fn(async()=>{}),dispose:vi.fn(async()=>{})});
 const a=provider(),b=provider(),plugin=(id:string,value=a):KanbanOperationPlugin=>({id,version:'1',label:id,actions:[{id:'publish',label:'Publish'}],create:()=>value});
 return {context,a,b,plugin};
}
const request={operationId:'op',itemId:'item',action:'publish',expectedRevision:'r1'};
it('routes identical action names by plugin identity and rejects ambiguous legacy routing',async()=>{
 const f=await fixture(),registry=await createOperationPluginRegistry(f.context,[f.plugin('documents'),f.plugin('inventory',f.b)]),api=registry.capabilities!;
 const view=await api.itemOperations!('board','item');expect(view.plugins?.map(row=>row.view.pluginId)).toEqual(['documents','inventory']);
 await expect(api.runItemOperation!('board',request)).rejects.toMatchObject({code:'OPERATION_PLUGIN_AMBIGUOUS'});
 await api.runItemOperation!('board',{...request,pluginId:'inventory'});expect(f.b.runItemOperation).toHaveBeenCalledWith('board',request);expect(f.a.runItemOperation).not.toHaveBeenCalled();
 await expect(api.runItemOperation!('board',{...request,pluginId:'documents'})).rejects.toMatchObject({code:'OPERATION_PLUGIN_BINDING_CHANGED'});
});
it('keeps one-plugin clients compatible and fences plugin versions across restart',async()=>{
 const f=await fixture(),first=await createOperationPluginRegistry(f.context,[f.plugin('documents')]);
 expect(await first.capabilities!.itemOperations!('board','item')).toMatchObject({revision:'r1',pluginId:'documents'});
 await first.capabilities!.runItemOperation!('board',request);
 const second=await createOperationPluginRegistry(f.context,[{...f.plugin('documents'),version:'2'}]);
 await expect(second.capabilities!.runItemOperation!('board',request)).rejects.toMatchObject({code:'OPERATION_PLUGIN_BINDING_CHANGED'});expect(f.a.runItemOperation).toHaveBeenCalledOnce();
});
it('does not let an explicit plugin id dispatch an undeclared action',async()=>{
 const f=await fixture(),registry=await createOperationPluginRegistry(f.context,[f.plugin('documents')]);
 await expect(registry.capabilities!.runItemOperation!('board',{...request,pluginId:'documents',action:'foreign'})).rejects.toMatchObject({code:'OPERATION_PLUGIN_ACTION_UNAVAILABLE'});
 expect(f.a.runItemOperation).not.toHaveBeenCalled();
});
it('preserves other plugin controls when one projection fails',async()=>{
 const f=await fixture();f.a.itemOperations.mockRejectedValueOnce(Object.assign(Error('private detail'),{code:'OFFLINE'}));
 const registry=await createOperationPluginRegistry(f.context,[f.plugin('documents'),f.plugin('inventory',f.b)]);
 const view=await registry.capabilities!.itemOperations!('board','item');
 expect(view.plugins?.[0].view).toMatchObject({code:'OFFLINE',operations:[]});expect(view.plugins?.[1].view.operations[0]).toMatchObject({id:'publish',enabled:true});
 expect(JSON.stringify(view)).not.toContain('private detail');
});
it('isolates lifecycle calls and disposes every provider even when one fails',async()=>{
 const f=await fixture();f.a.dispose.mockRejectedValueOnce(Error('dispose failure'));
 const registry=await createOperationPluginRegistry(f.context,[f.plugin('documents'),f.plugin('inventory',f.b)]);
 await registry.scan!();await registry.quiesce!();await expect(registry.dispose!()).rejects.toThrow('OPERATION_PLUGIN_DISPOSE_FAILED');
 expect(f.a.scan).toHaveBeenCalledOnce();expect(f.b.quiesce).toHaveBeenCalledOnce();expect(f.b.dispose).toHaveBeenCalledOnce();
});
it('rejects duplicate plugin identities, missing dependencies and dependency cycles before creating providers',async()=>{
 const f=await fixture(),create=vi.fn(()=>f.a),base={...f.plugin('documents'),create};
 await expect(createOperationPluginRegistry(f.context,[base,base])).rejects.toMatchObject({code:'OPERATION_PLUGIN_INVALID'});
 await expect(createOperationPluginRegistry(f.context,[{...base,actions:[{id:'publish',label:'Publish',dependsOn:['foreign']}]}])).rejects.toMatchObject({code:'OPERATION_PLUGIN_ACTIONS_INVALID'});
 await expect(createOperationPluginRegistry(f.context,[{...base,actions:[{id:'publish',label:'Publish',dependsOn:['check']},{id:'check',label:'Check',dependsOn:['publish']}]}])).rejects.toMatchObject({code:'OPERATION_PLUGIN_DEPENDENCY_CYCLE'});
 expect(create).not.toHaveBeenCalled();
});
