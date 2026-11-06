export interface KanbanRecordConversation {
    id:string;boardId:string;sessionId?:string;resourceId?:string;recordId?:string;
    state:'preparing'|'clarifying'|'draft'|'confirmed'|'error';code?:string;createdAt:number;
}
