/** Host-defined board configuration; values never grant execution authority. */
export interface KanbanBoardSetting {
    name:string;label:string;description?:string;
    choices:Array<{value:string;label:string;disabled?:boolean}>;
}
export interface KanbanBoardSettingsCatalog {fields:KanbanBoardSetting[];description?:string}
