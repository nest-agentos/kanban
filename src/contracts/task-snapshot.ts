import type {KanbanService,KanbanBoardSummary} from './contracts';
import type {KanbanPrincipal} from './configuration';
import type {KanbanExecutionSessionDetail,KanbanPlanningSession,KanbanSessionItemPage} from './activity';
import type {KanbanItemOperations} from './operations';
import type {KanbanTaskRecovery} from './recovery';
import type {KanbanRecordResource} from './record-execution';
import type {KanbanWorkResource} from './work-resources';

export type KanbanTaskRead<T> = {value:T;code?:never}|{value?:never;code:string};

/** Authorized first view for one task. Interactive and historical reads retain their own entry points. */
export interface KanbanTaskSnapshot {
    boards:KanbanBoardSummary[];
    sidebarIncluded?:boolean;
    actor:KanbanPrincipal;
    detail:Awaited<ReturnType<KanbanService['item']>>;
    resources?:KanbanTaskRead<KanbanRecordResource[]>;
    operations?:KanbanTaskRead<KanbanItemOperations>;
    planning?:KanbanTaskRead<KanbanPlanningSession|undefined>;
    execution?:KanbanTaskRead<KanbanExecutionSessionDetail>;
    recovery?:KanbanTaskRead<KanbanTaskRecovery>;
    children?:KanbanTaskRead<KanbanSessionItemPage>;
    successors?:KanbanTaskRead<KanbanSessionItemPage>;
    workResources?:KanbanTaskRead<KanbanWorkResource[]>;
}
export interface KanbanTaskSnapshotOptions {includeSidebar?:boolean}
export type KanbanPreparedTask={boardId:string;itemId:string}&KanbanTaskSnapshotOptions&KanbanTaskRead<KanbanTaskSnapshot>;
