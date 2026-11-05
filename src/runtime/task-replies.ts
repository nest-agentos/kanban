import type {KanbanClient,KanbanItem,KanbanDispatch} from '../contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import {requireValue} from '../rules';
export interface KanbanTaskReply {itemId:string;attemptId:string;replyTo:string;operationId:string;content:string}
export type FrozenReply<T=unknown> = T & {phase?:'prepared'|'submitting'|'cancelling'|'cancelled';boardId:string;request:KanbanTaskReply;sessionId:string};
export interface KanbanReplyPort<T> {
    prepare(input:{boardId:string;request:KanbanTaskReply;item:KanbanItem;dispatch:KanbanDispatch}):Promise<T & {sessionId:string}>;
    deliver(reply:FrozenReply<T>):Promise<void>;
}
/** The durable Session queue carries correlated user input without a workspace mailbox. */
export function taskReplies<T>(service:KanbanClient,journal:KanbanAutomationJournal,port:KanbanReplyPort<T>) {
    const replyTask=async(boardId:string,request:KanbanTaskReply):Promise<void>=>{
        requireValue(/^[\w-]{1,96}$/.test(request.operationId)&&typeof request.content==='string'&&!!request.content.trim()&&request.content.length<=8000,'WORKSPACE_REPLY_INVALID');
        await service.item(boardId,request.itemId);
        const old=await journal.get<FrozenReply<T>>('task-reply:'+request.operationId);
        requireValue(!old||old.boardId===boardId&&JSON.stringify(old.request)===JSON.stringify(request),'IDEMPOTENCY_CONFLICT');
        if(await journal.get('task-reply-delivered:'+request.operationId))return;
        const frozen=await freezeReply(service,journal,port,boardId,request);
        await journal.update<string[]>('task-reply-index',previous=>previous?.includes(request.operationId)?previous:[...previous??[],request.operationId]);
        const claimed = await journal.claim('task-reply:' + request.operationId);
        const current = (await journal.get<FrozenReply<T>>('task-reply:' + request.operationId))!;
        if (current.phase === 'cancelled' || current.phase === 'cancelling') return;
        if (claimed || current.phase === 'submitting' || current.phase === undefined) await port.deliver(frozen);
        await journal.update('task-reply-delivered:'+request.operationId,()=>true);
    };
    return Object.assign(replyTask,{async scan(){
        for(const id of await journal.get<string[]>('task-reply-index')??[]) {
            if(await journal.get('task-reply-delivered:'+id)||await journal.get('task-reply-cancelled:'+id))continue;
            const saved=await journal.get<FrozenReply<T>>('task-reply:'+id);if(saved&&!['cancelling','cancelled'].includes(saved.phase??'') && !(await service.read(saved.boardId)).lifecycle)await replyTask(saved.boardId,saved.request);
        }
    }});
}
async function freezeReply<T>(service:KanbanClient,journal:KanbanAutomationJournal,port:KanbanReplyPort<T>,boardId:string,request:KanbanTaskReply):Promise<FrozenReply<T>> {
    const {item}=await service.item(boardId,request.itemId);
    requireValue(item.deletedAt===undefined&&item.control?.action!=='cancel','TASK_CANCELLING');
    const workflow=await service.workflow(boardId),dispatch=workflow.dispatches[request.attemptId];
    requireValue(dispatch?.itemId===item.id&&item.owner?.token===dispatch.fence&&['prepared','running','unknown'].includes(dispatch.outcome),'STALE_EXECUTION_RESULT');
    requireValue(item.issues?.some(issue=>issue.id===request.replyTo&&issue.attemptId===request.attemptId&&!issue.resolvedBy),'ISSUE_NOT_FOUND');
    const previous=await journal.get<FrozenReply<T>>('task-reply:'+request.operationId);
    if(previous)return previous;
    const prepared=await port.prepare({boardId,request,item,dispatch});
    return journal.update<FrozenReply<T>>('task-reply:'+request.operationId,old=>{
        requireValue(!old||old.boardId===boardId&&JSON.stringify(old.request)===JSON.stringify(request),'IDEMPOTENCY_CONFLICT');
        return old??{...prepared,phase:'prepared',boardId,request:structuredClone(request)};
    });
}
