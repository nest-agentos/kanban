export interface KanbanRecordTaskEdit {id:string;revision:number;title:string;responsibility:string;acceptance:string}
export type KanbanRecordRevisionCommand =
    | {type:'begin-record-edit';recordId:string;editId:string;recordRevision:number;items:Array<{id:string;revision:number}>}
    | {type:'save-record-edit';recordId:string;editId:string;recordRevision:number;title:string;content:string;rationale:string;items:KanbanRecordTaskEdit[]}
    | {type:'end-record-edit';recordId:string;editId:string;items:string[]};
