import type {IFileSystem} from '@nestos/vfs-core';
import type {KanbanActivityModuleOptions,KanbanActivityHandle} from '../activity';
import type {KanbanActor,KanbanClient} from '../contracts';
import type {KanbanStore} from '../ports';
import type {KanbanAutomationJournal} from './automation-journal';
import type {KanbanWorkLog} from './work-log';
import type {KanbanJournalOptions,KanbanWorkLogOptions,KanbanResourceCatalog} from './ports';
import type {KanbanTaskControlOptions} from './control-ports';
import type {KanbanAutomationOptions} from './automation';
export interface KanbanRuntimeContext {
    fs:IFileSystem;store:KanbanStore;service:KanbanActivityHandle;journal:KanbanAutomationJournal;workLog:KanbanWorkLog;
    serviceFor(actor:KanbanActor):KanbanActivityHandle;
}
/** Extensions bind host facilities; recovery and shutdown are coordinated by the runtime. */
export interface KanbanRuntimeExtension {
    operationPlugins?:import('./operation-plugins').KanbanOperationPlugin[];
    projectManagementTask?(boardId:string,itemId:string,task:import('../contracts').KanbanTaskProjection):Promise<import('../contracts').KanbanTaskProjection>;
    projectRecords?(boardId:string,page:import('../contracts').KanbanRecordPage):Promise<import('../contracts').KanbanRecordPage>;
    archiveItemResources?(boardId:string,itemId:string,operationId:string):Promise<void>;
    capabilities?:Partial<KanbanClient>;
    scan?():Promise<void>;quiesce?():Promise<void>;dispose?():Promise<void>;
}
export interface KanbanRuntimeOptions extends Omit<KanbanActivityModuleOptions,'store'|'referenceSystem'> {
    fs:IFileSystem;directory?:string;store?:KanbanStore;referenceSystem?:string;
    journal?:KanbanJournalOptions | KanbanAutomationJournal;workLog?:KanbanWorkLogOptions;
    archiveSession?(sessionId:string,operationId:string):Promise<void>;
    resources?:KanbanResourceCatalog;requiresItemResource?: (board:import('../contracts').KanbanBoard)=>boolean;
    recurringAutomation?(board:import('../contracts').KanbanBoard,record:import('../contracts').KanbanProjectRecord):Promise<NonNullable<import('../contracts').KanbanBoard['automation']>>;
    assertRestartIdle?(boardId:string,itemIds:string[]):Promise<void>;
    control?:KanbanTaskControlOptions;
    automation?:Omit<KanbanAutomationOptions,'fs'|'directory'|'service'|'serviceFor'|'journal'|'workLog'|'log'>;
    operationPlugins?:import('./operation-plugins').KanbanOperationPlugin[];
    extensions?(context:KanbanRuntimeContext):KanbanRuntimeExtension[];
    prepareRecordReads?(service:KanbanActivityHandle):Pick<KanbanActivityHandle,'query'|'queryActivity'>;
    createService?(options:KanbanActivityModuleOptions):KanbanActivityHandle;
}
