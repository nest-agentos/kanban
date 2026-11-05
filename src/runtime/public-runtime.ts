import {assembleKanbanRuntime} from './runtime';
import {runtimeAuthorization} from './public-authorization';
import {createExecutionRuntime} from './public-execution';
import {requireValue} from '../rules';
import type {KanbanRuntime,KanbanRuntimeOptions} from './public-ports';
import type {KanbanRuntimeContext} from './runtime-ports';
/** The public instance contains semantic operations only; all coordination state is private. */
export async function createKanbanRuntime(options:KanbanRuntimeOptions):Promise<KanbanRuntime> {
    let context:KanbanRuntimeContext|undefined,execution:ReturnType<typeof createExecutionRuntime>|undefined;
    const assembled=await assembleKanbanRuntime({...options,authorize:runtimeAuthorization(options),log:options.log??(()=>{}),
        referenceSystem:'kanban-execution',executionSessions:options.activity?{source:options.activity}:undefined,
        verifyOutputs:async({board,itemId,dispatchId,outputs})=>{
            if(!context||!dispatchId)return false;
            const dispatch=(await context.service.workflow(board.id)).dispatches[dispatchId];
            return dispatch?.itemId===itemId&&context.journal.verify(outputs,dispatchId);
        },control:{control:{control:request=>execution?.controls.control.control(request)??Promise.resolve('unknown'),
            inspect:(id,attempt)=>execution?.controls.control.inspect?.(id,attempt)??Promise.resolve(undefined)}},
        extensions:bound=>{
            context=bound;if(!options.execution)return [];
            execution=createExecutionRuntime(bound,options.execution,options.resources?.system);
            return [{...execution,capabilities:{automationCatalog:execution.automationCatalog,analysisStatus:execution.analysisStatus}}];
        }});
    const service=assembled.service;
    return {...service,results:async(boardId,dispatchId)=>{
        const dispatch=(await service.workflow(boardId)).dispatches[dispatchId];requireValue(dispatch,'DISPATCH_NOT_FOUND');
        const outputs=dispatch.outputs??[];requireValue(!outputs.length||await assembled.journal.verify(outputs,dispatchId),'ARTIFACT_INVALID');
        return Promise.all(outputs.map(async reference=>({reference,value:JSON.parse((await assembled.journal.get<string>('artifact:'+reference.sha256))!)})));
    }};
}
