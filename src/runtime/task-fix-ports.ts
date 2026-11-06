import type {KanbanClient,KanbanItem,KanbanDispatch,KanbanFixSession} from '../contracts';
import type {KanbanExecutionPort} from '../execution';
import type {KanbanAutomationJournal} from './automation-journal';
import type {KanbanExecutionControlPort} from './control-ports';
import type {KanbanRuntimeDiagnostic} from './ports';
export interface Definition {repair?:{itemId:string;revision:number};title:string; responsibility:string; acceptance:string; type:string; dependencies:string[]; children?:Array<import('../contracts').KanbanWorkDefinition&{estimate?:import('../contracts').KanbanEstimate}>}
export interface Snapshot {proposalId:string; messageId:string; content:string; definition:Definition; digest:string; operationId:string}
export interface SavedFix extends KanbanFixSession {
    origin?:{id:string;input:unknown}; phase:'prepared'|'submitting'|'settled'; cancelOperationId?: string; dispatch:KanbanDispatch; item:KanbanItem; resourceId:string; context:unknown; request:unknown;
    snapshot?:Snapshot; code?:string; accepted?:boolean;
}
export interface KanbanFixOptions<Instruction = unknown> {
    service:KanbanClient;journal:KanbanAutomationJournal;
    executor:KanbanExecutionPort;control:KanbanExecutionControlPort;
    freeze(boardId:string,request:{itemId:string;operationId:string}):Promise<SavedFix>;
    confirm(fix:SavedFix,input:Instruction):Promise<boolean>;
    observe(fix:SavedFix):Promise<void>;
    accept(fix:SavedFix):Promise<void>;
    log(event:KanbanRuntimeDiagnostic & {result:'success'|'failure'}):void;
}
