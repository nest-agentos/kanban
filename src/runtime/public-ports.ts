import type {IFileSystem} from '@nestos/vfs-core';
import type {KanbanActor,KanbanExternalReference,KanbanAutomationCatalog,KanbanService,KanbanClient,KanbanArtifactRef} from '../contracts';
import type {KanbanModuleOptions} from '../ports';
import type {KanbanSessionSource} from '../activity';
import type {KanbanResourceCatalog,KanbanRuntimeDiagnostic} from './ports';
/** A persistable adapter-owned binding. Its payload is never interpreted by Kanban. */
export interface KanbanExecutionHandle {id:string;data?:unknown}
export interface KanbanExecutionIntent {
    id:string;purpose:'planning'|'work';
    scope:{boardId:string;itemId:string;itemRevision:number};
    target:KanbanExternalReference;context:unknown;preparation?:{reference:KanbanExternalReference;options?:Record<string,string>};previous?:KanbanExecutionHandle;
}
export interface KanbanExecutionReceipt {
    outcome:'running'|'unknown'|'succeeded'|'failed'|'cancelled';
    executionId?:string;result?:unknown;code?:string;
    controlCapabilities?:{pause:'boundary'|'none';resume:boolean};
}
export interface KanbanExecutionAdapter {
    catalog():Promise<KanbanAutomationCatalog>;
    /** Prepare a binding without starting external work. The runtime persists it before submit. */
    prepare(intent:KanbanExecutionIntent):Promise<KanbanExecutionHandle>;
    submit(handle:KanbanExecutionHandle):Promise<KanbanExecutionReceipt>;
    inspect(handle:KanbanExecutionHandle):Promise<KanbanExecutionReceipt>;
    control?(handle:KanbanExecutionHandle,command:{operationId:string;action:'pause'|'resume'|'cancel'}):Promise<'accepted'|'paused'|'resumed'|'cancelled'|'unknown'>;
}
export interface KanbanRuntimeOptions {
    fs:IFileSystem;directory?:string;actor:KanbanActor;
    authorize:KanbanModuleOptions['authorize'];
    execution?:KanbanExecutionAdapter;resources?:KanbanResourceCatalog;activity?:KanbanSessionSource;
    onCommitted?:KanbanModuleOptions['onCommitted'];
    log?(event:KanbanRuntimeDiagnostic):void;
}
/** All persistence, projections, control and deletion barriers are owned by this service. */
export interface KanbanRuntime extends KanbanService,Pick<KanbanClient,'previewTaskRestart'|'restartTask'|'records'|'record'|'runRecord'|'recordExecutions'|'controlRecord'|'itemResources'|'recordResources'|'previewDeletion'|'deleteBoard'|'cancelBoard'|'requestBoardDeletion'|'queryActivity'|'executionSession'|'automationCatalog'|'analysisStatus'> {
    results(boardId:string,dispatchId:string):Promise<Array<{reference:KanbanArtifactRef;value:unknown}>>;
    quiesce():Promise<void>;dispose():Promise<void>;
}
