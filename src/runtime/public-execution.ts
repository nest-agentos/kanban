import type {KanbanBoard,KanbanItem} from '../contracts';
import {DEFAULT_KANBAN_WORK_TYPES} from '../contracts';
import type {KanbanExecutionPort} from '../execution';
import type {KanbanRuntimeContext} from './runtime-ports';
import type {KanbanExecutionAdapter,KanbanExecutionHandle,KanbanExecutionIntent,KanbanExecutionReceipt} from './public-ports';
import type {KanbanTaskControlOptions} from './control-ports';
import {ExecutionBindings} from './execution-bindings';
import {createKanbanAutomation} from './automation';
import {analyzeItem} from './analysis';
import {drainBoardAnalyses} from './board-drain';
import {scanTaskControls} from './task-controls';
import {workContext} from './work-context';
import {defaultReferences} from './ports';
import {requireValue} from '../rules';
export function createExecutionRuntime(context:KanbanRuntimeContext,adapter:KanbanExecutionAdapter,resourceSystem=defaultReferences.resource) {
    const bindings=new ExecutionBindings(context.journal),references={...defaultReferences,resource:resourceSystem};
    const prepare=async(intent:KanbanExecutionIntent)=>bindings.save(intent,await adapter.prepare(intent));
    const controls:KanbanTaskControlOptions={control:{
        control:async request=>{
            const handle=await bindings.get(request.attemptId??request.executionId);
            requireValue(adapter.control,'TASK_CONTROL_UNSUPPORTED');requireValue(handle,'TASK_CONTROL_ROUTE_MISSING');
            return adapter.control(handle,{operationId:request.operationId,action:request.action});
        },inspect:async(id,attempt=id)=>{
            const handle=await bindings.get(attempt);if(!handle)return undefined;
            const receipt=validateReceipt(await adapter.inspect(handle));
            return {settled:['succeeded','failed','cancelled'].includes(receipt.outcome),outcome:terminalOutcome(receipt)};
        }}};
    const automation=createKanbanAutomation({...context,directory:context.journal.directory+'/executions',catalog:()=>adapter.catalog(),
        log:event=>context.journal.diagnostic(event),controls:(board,service)=>scanTaskControls(controls,context.journal,board,service),
        drain:(board,service)=>drainBoardAnalyses(controls,context.journal,board,service),
        executor:async execution=>workExecutor(context,adapter,prepare,execution.boardId,references,execution.dependencies),
        analyze:async(board,item,service,active)=>analyzeItem({journal:context.journal,active,log:event=>context.journal.diagnostic(event),
            inheritReferences:refs=>refs.filter(ref=>[references.resource,references.decision].includes(ref.system)),
            port:{prepare:async({id,target})=>prepare({id,purpose:'planning',target,...preparation(board),scope:scope(board,item),context:{...await executionContext(context,board,item,references),
                workTypes:board.workTypes??DEFAULT_KANBAN_WORK_TYPES,related:board.items.map(({id,title,status,planning})=>({id,title,status,planning}))}}),
                prepareExecution:async()=>{},submit:async handle=>{await adapter.submit(handle);},
                inspect:async(_id,handle)=>{const receipt=validateReceipt(await adapter.inspect(handle));return {state:receipt.outcome,output:receipt.result,code:receipt.code};}}},
            board,item,board.automation?.enabled?board.automation.planner:undefined,service)});
    return {...automation,controls};
}
function workExecutor(context:KanbanRuntimeContext,adapter:KanbanExecutionAdapter,prepare:(intent:KanbanExecutionIntent)=>Promise<KanbanExecutionHandle>,boardId:string,references:typeof defaultReferences,dependencies:(item:KanbanItem)=>Promise<unknown>):KanbanExecutionPort {
    const frozen=async(dispatch:Parameters<KanbanExecutionPort['prepare']>[0],item:KanbanItem,previous?:KanbanExecutionHandle)=>{
        const board=await context.service.read(boardId);requireValue(board.automation,'AUTOMATION_UNAVAILABLE');
        return {id:dispatch.id,handle:await prepare({id:dispatch.id,purpose:'work',...preparation(board),scope:scope(board,item),target:board.automation.executor,
            context:{...await executionContext(context,board,item,references),inputs:dispatch.inputs,dependencies:await dependencies(item)},...(previous?{previous}:{})})};
    };
    const observe=async(value:unknown,submit:boolean)=>{
        const saved=value as {id:string;handle:KanbanExecutionHandle};requireValue(saved?.id&&saved.handle?.id,'EXECUTION_HANDLE_INVALID');
        const receipt=validateReceipt(await (submit?adapter.submit(saved.handle):adapter.inspect(saved.handle)));
        if(receipt.outcome==='succeeded'&&receipt.result===undefined)return {outcome:'unknown' as const,code:'EXECUTION_RESULT_PENDING',executionSessionId:receipt.executionId};
        const outputs=receipt.outcome==='succeeded'&&receipt.result!==undefined?await context.journal.artifact(saved.id,receipt.result):undefined;
        return {outcome:receipt.outcome,code:receipt.code,executionSessionId:receipt.executionId,controlCapabilities:receipt.controlCapabilities,outputs};
    };
    return {prepare:frozen,prepareContinuation:(dispatch,item,previous)=>frozen(dispatch,item,(previous as {handle:KanbanExecutionHandle}).handle),start:value=>observe(value,true),inspect:value=>observe(value,false)};
}
function scope(board:KanbanBoard,item:KanbanItem):KanbanExecutionIntent['scope'] {return {boardId:board.id,itemId:item.id,itemRevision:item.revision};}
function terminalOutcome(receipt:KanbanExecutionReceipt):'succeeded'|'failed'|'cancelled'|undefined {
    return receipt.outcome==='succeeded'||receipt.outcome==='failed'||receipt.outcome==='cancelled'?receipt.outcome:undefined;
}

async function executionContext(context:KanbanRuntimeContext,board:KanbanBoard,item:KanbanItem,references:typeof defaultReferences) {
    const value=await workContext(context.journal,board,item,references),decision=value.decision;
    return {...value,decision:decision?{sourceBoardId:decision.sourceBoardId,recordId:decision.recordId,recordRevision:decision.recordRevision,runId:decision.runId}:null};
}
function validateReceipt(receipt:KanbanExecutionReceipt):KanbanExecutionReceipt {
    requireValue(receipt&&['running','unknown','succeeded','failed','cancelled'].includes(receipt.outcome),'EXECUTION_RECEIPT_INVALID');
    requireValue(receipt.executionId===undefined||typeof receipt.executionId==='string'&&receipt.executionId.length>0&&receipt.executionId.length<=512,'EXECUTION_RECEIPT_INVALID');
    requireValue(receipt.code===undefined||typeof receipt.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(receipt.code),'EXECUTION_RECEIPT_INVALID');
    return receipt;
}

function preparation(board:KanbanBoard):Pick<KanbanExecutionIntent,'preparation'> {
    return board.automation?.preparation?{preparation:{reference:board.automation.preparation,options:board.automation.preparationOptions}}:{};
}
