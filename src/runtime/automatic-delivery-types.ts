import type {KanbanBoard,KanbanItem,KanbanItemOperationRequest,KanbanItemOperations,KanbanService} from '../contracts';
import type {KanbanAutomationJournal} from './automation-journal';
/** Persist only the frozen plan, cursor, operation identities and recovery evidence. */
export interface AutomaticDeliveryState {
    id:string;boardId:string;itemId:string;executionId:string;scopeId?:string;
    ordering?:'configured';steps?:string[];step:number;
    manualAfter?:string;manualOrder?:string[];reportedBoundary?:string;
    target?:string;waitingForTarget?:boolean;targetActions?:string[];
    handoff?:{boardId:string;itemId:string;at:number};
    code?:string;cleanupPrecondition?:boolean;resolvedBy?:string;revisionEpoch?:string;
    requests:Record<string,KanbanItemOperationRequest>;
    /** Legacy storage and compatibility reports; new checkpoints never write these fields. */
    done?:boolean;waitingForUser?:boolean;
}
export interface AutomaticDeliveryPolicy {steps:string[];targetActions?:string[];finalizeAction:string;handoffAction:string;refreshAction:string;refreshableActions:string[];refreshCodes:string[];unstartedCodes:string[]}
export interface AutomaticDeliveryOptions {policy:AutomaticDeliveryPolicy;scopeId?:string;service:KanbanService;journal:KanbanAutomationJournal;active():boolean;
    handoff?(board:KanbanBoard,item:KanbanItem):Promise<{boardId:string;itemId:string}|undefined>;
    settle?(board:string,item:string):Promise<void>;
    plan?(board:KanbanBoard,item:KanbanItem):Promise<{steps:string[];manualAfter?:string;ordering?:'configured'}>;
    target?(board:KanbanBoard,item:KanbanItem):string|undefined;automatic?(board:KanbanBoard,item:KanbanItem):Promise<boolean>;cleanup?(board:string,item:string,id:string):Promise<boolean>;
    reanalysis?(board:string,item:string,previousOperationId?:string):Promise<{revision:string}|undefined>;
    retryPrecondition?(board:string,item:string,action:string,code:string):Promise<boolean>;
    view(board:string,item:string):Promise<KanbanItemOperations>;run(board:string,request:KanbanItemOperationRequest):Promise<KanbanItemOperations>;
    report?(state:AutomaticDeliveryState):Promise<void>}
