import {safeCode} from './diagnostics';
import type {KanbanOperationPluginDescriptor,KanbanItemOperations,KanbanItemOperationRequest,KanbanItemOperationBinding,KanbanBoard,KanbanItem} from '../contracts';
import type {KanbanRuntimeContext,KanbanRuntimeExtension} from './runtime-ports';
import {sha256HexSync} from '../utils';
import {requireValue} from '../rules';
export interface KanbanOperationProvider {
    applies?(board:KanbanBoard,item:KanbanItem):Promise<boolean>|boolean;
    itemOperations(board:string,item:string):Promise<KanbanItemOperations>;
    runItemOperation(board:string,request:KanbanItemOperationRequest):Promise<KanbanItemOperations>;
    bindItemOperation?(board:string,request:KanbanItemOperationBinding):Promise<KanbanItemOperations>;
    scan?():Promise<void>;quiesce?():Promise<void>;dispose?():Promise<void>;
}
export type KanbanOperationPluginContext=Pick<KanbanRuntimeContext,'service'|'journal'|'workLog'>;
export interface KanbanOperationPlugin extends KanbanOperationPluginDescriptor {
    create(context:KanbanOperationPluginContext):KanbanOperationProvider;
}
type Entry={plugin:KanbanOperationPluginDescriptor;provider:KanbanOperationProvider};
/** Trusted installation, not model-supplied code. Providers retain their own durable execution receipts. */
export async function createOperationPluginRegistry(context:KanbanRuntimeContext,plugins:KanbanOperationPlugin[]):Promise<KanbanRuntimeExtension> {
    validatePlugins(plugins);const entries:Entry[]=[];
    try{for(const plugin of plugins)entries.push({plugin:structuredClone({id:plugin.id,version:plugin.version,label:plugin.label,actions:plugin.actions}),provider:plugin.create(context)});}
    catch(error){const stopped=await Promise.allSettled([lifecycle(entries,'quiesce')]);const disposed=await Promise.allSettled([lifecycle(entries,'dispose')]);
        throw new AggregateError([error,...[...stopped,...disposed].flatMap(row=>row.status==='rejected'?[row.reason]:[])],'OPERATION_PLUGIN_INITIALIZATION_FAILED');}
    return {capabilities:{itemOperations:(board,item)=>readOperations(context,entries,board,item),
        runItemOperation:(board,request)=>execute(context,entries,board,request),bindItemOperation:(board,request)=>execute(context,entries,board,request,true)},
        scan:()=>lifecycle(entries,'scan'),quiesce:()=>lifecycle(entries,'quiesce'),dispose:()=>lifecycle(entries,'dispose')};
}
async function applicable(context:KanbanRuntimeContext,entries:Entry[],board:string,item:string):Promise<Entry[]> {
    const current=await context.service.read(board),detail=await context.service.item(board,item),selected:Entry[]=[];
    for(const entry of entries)if(!entry.provider.applies||await entry.provider.applies(current,detail.item))selected.push(entry);
    return selected;
}
async function readOperations(context:KanbanRuntimeContext,entries:Entry[],board:string,item:string):Promise<KanbanItemOperations> {
    const current=await context.service.read(board),detail=await context.service.item(board,item);
    const values=await Promise.all(entries.map(async entry=>{
        try{if(entry.provider.applies&&!await entry.provider.applies(current,detail.item))return;
            return {...entry.plugin,view:tag(await entry.provider.itemOperations(board,item),entry.plugin.id)};
        }catch(error){const code=safeCode(error,'OPERATION_PLUGIN_READ_FAILED');
            context.journal.diagnostic({operationId:entry.plugin.id,boardId:board,itemId:item,stage:'operation.plugin.read',result:'failure',code,durationMs:0});
            return {...entry.plugin,view:{pluginId:entry.plugin.id,revision:sha256HexSync(JSON.stringify([entry.plugin.id,entry.plugin.version,code])),code,operations:[]}};}
    }));
    const rows=values.filter((row):row is NonNullable<typeof row>=>!!row);
    if(rows.length===1)return rows[0].view;
    return {revision:sha256HexSync(JSON.stringify(rows.map(row=>[row.id,row.version,row.view.revision]))),operations:[],plugins:rows};
}
async function execute(context:KanbanRuntimeContext,entries:Entry[],board:string,request:KanbanItemOperationRequest|KanbanItemOperationBinding,binding=false):Promise<KanbanItemOperations> {
    const started=Date.now();
    try{
        requireValue(/^[\w-]{1,128}$/.test(request.operationId)&&typeof request.itemId==='string'&&typeof request.expectedRevision==='string','OPERATION_REQUEST_INVALID');
        const candidates=(await applicable(context,request.pluginId?entries.filter(entry=>entry.plugin.id===request.pluginId):entries,board,request.itemId)).filter(entry=>request.pluginId?entry.plugin.id===request.pluginId:entry.plugin.actions.some(action=>action.id===(('skip' in request?request.skip?.action:undefined)??request.action))||!!('cancel' in request&&request.cancel));
        requireValue(candidates.length===1,candidates.length?'OPERATION_PLUGIN_AMBIGUOUS':'OPERATION_PLUGIN_UNAVAILABLE');
        const {plugin,provider}=candidates[0],{pluginId:_,...input}=request;
        const action=('skip' in request?request.skip?.action:undefined)??request.action;
        requireValue(plugin.actions.some(entry=>entry.id===action)||!binding&&'cancel' in request&&request.cancel&&request.action==='cancel','OPERATION_PLUGIN_ACTION_UNAVAILABLE');
        await freezeRoute(context,plugin,board,input,binding);
        if(binding){requireValue(provider.bindItemOperation,'OPERATION_BINDING_UNAVAILABLE');await provider.bindItemOperation(board,input as KanbanItemOperationBinding);}
        else await provider.runItemOperation(board,input as KanbanItemOperationRequest);
        context.journal.diagnostic({operationId:request.operationId,boardId:board,itemId:request.itemId,stage:'operation.plugin.dispatch',result:'success',durationMs:Date.now()-started});
        return readOperations(context,entries,board,request.itemId);
    }catch(error){context.journal.diagnostic({operationId:request.operationId,boardId:board,itemId:request.itemId,stage:'operation.plugin.dispatch',result:'failure',code:safeCode(error,'OPERATION_PLUGIN_FAILED'),durationMs:Date.now()-started});throw error;}
}
async function freezeRoute(context:KanbanRuntimeContext,plugin:KanbanOperationPluginDescriptor,board:string,input:KanbanItemOperationRequest|KanbanItemOperationBinding,binding:boolean):Promise<void> {
    const fingerprint=sha256HexSync(JSON.stringify([board,input,binding])),key='operation-plugin:'+input.operationId;
    await context.journal.update<{pluginId:string;version:string;fingerprint:string}>(key,old=>{
        requireValue(!old||old.pluginId===plugin.id&&old.version===plugin.version&&old.fingerprint===fingerprint,'OPERATION_PLUGIN_BINDING_CHANGED');
        return old??{pluginId:plugin.id,version:plugin.version,fingerprint};
    });
}
function tag(view:KanbanItemOperations,pluginId:string):KanbanItemOperations {
    return {...view,pluginId,...(view.scopes?{scopes:view.scopes.map(scope=>({...scope,view:tag(scope.view,pluginId)}))}:{})};
}
function validatePlugins(plugins:KanbanOperationPlugin[]):void {
    const ids=new Set<string>();
    for(const plugin of plugins){
        requireValue(/^[a-zA-Z0-9][\w-]{0,63}$/.test(plugin.id)&&!ids.has(plugin.id)&&!!plugin.version&&!!plugin.label,'OPERATION_PLUGIN_INVALID');
        ids.add(plugin.id);const actions=new Set(plugin.actions.map(action=>action.id));
        requireValue(actions.size===plugin.actions.length&&actions.size>0&&plugin.actions.every(action=>/^[\w-]{1,64}$/.test(action.id)&&!!action.label&&action.dependsOn?.every(id=>actions.has(id)&&id!==action.id)!==false),'OPERATION_PLUGIN_ACTIONS_INVALID');
        const settled=new Set<string>();
        for(let i=0;i<plugin.actions.length;i++)for(const action of plugin.actions)if((action.dependsOn??[]).every(id=>settled.has(id)))settled.add(action.id);
        requireValue(settled.size===actions.size,'OPERATION_PLUGIN_DEPENDENCY_CYCLE');
    }
}
async function lifecycle(entries:Array<{provider:KanbanOperationProvider}>,method:'scan'|'quiesce'|'dispose'):Promise<void> {
    const results=await Promise.allSettled(entries.map(entry=>entry.provider[method]?.()));
    const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
    if(errors.length)throw new AggregateError(errors,'OPERATION_PLUGIN_'+method.toUpperCase()+'_FAILED');
}
