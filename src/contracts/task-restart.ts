export interface KanbanRestartPreview {itemId:string;version:string;affected:Array<{id:string;title:string;number?:number;status:string;started:boolean}>}
export interface KanbanRestartRequest {operationId:string;itemId:string;version:string;confirmed:boolean}
export interface KanbanRestartResult {operationId:string;itemId:string;state:'stopping'|'restarted';affectedIds:string[];code?:string}
export type KanbanRestartCommand =
    | {type:'prepare-task-restart';itemId:string;restartId:string;version:string}
    | {type:'commit-task-restart';itemId:string;restartId:string;affectedIds:string[]};

export type RepairDependencyCommand={type:'insert-repair-dependency';itemId:string;expectedItemRevision:number;plan:import('./workflow').KanbanWorkPlan};
