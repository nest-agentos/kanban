import type {KanbanClient,KanbanDecisionDependency,KanbanProjectRecord,KanbanRecordExecution,KanbanRecordSummary} from '../contracts';
import {requireValue} from '../rules';
/** Traverse identities, not display titles, and bound work even for malformed historical graphs. */
export async function validateDecisionDependencies(service:Pick<KanbanClient,'record'>,board:string,id:string,dependencies:KanbanDecisionDependency[]=[]) {
    requireValue(Array.isArray(dependencies)&&dependencies.length<=16,'DECISION_DEPENDENCIES_INVALID');
    const root=JSON.stringify([board,id]),records=new Map<string,KanbanProjectRecord>(),path=new Set([root]);let visits=0;
    async function visit(ref:KanbanDecisionDependency):Promise<void> {
        requireValue(ref&&typeof ref.boardId==='string'&&typeof ref.recordId==='string','DECISION_DEPENDENCIES_INVALID');
        const key=JSON.stringify([ref.boardId,ref.recordId]);requireValue(!path.has(key),'DECISION_DEPENDENCY_CYCLE');
        if(records.has(key))return;requireValue(++visits<=200&&path.size<=32,'DECISION_DEPENDENCY_LIMIT');
        const record=await service.record(ref.boardId,ref.recordId);
        requireValue(record.kind==='decision'&&record.status==='confirmed'&&record.deletedAt===undefined,'DECISION_DEPENDENCY_UNAVAILABLE');
        path.add(key);for(const next of record.dependsOn??[])await visit(next);path.delete(key);records.set(key,record);
    }
    for(const ref of dependencies)await visit(ref);
    return dependencies.map(ref=>({...ref,title:records.get(JSON.stringify([ref.boardId,ref.recordId]))!.title}));
}
export async function decisionDependencyStates(dependencies:KanbanDecisionDependency[],read:(board:string)=>Promise<KanbanRecordSummary[]>):Promise<NonNullable<KanbanRecordExecution['dependencies']>> {
    const pages=new Map<string,Promise<KanbanRecordSummary[]>>();
    return Promise.all(dependencies.map(async ref=>{
        let page=pages.get(ref.boardId);if(!page){page=read(ref.boardId);pages.set(ref.boardId,page);}
        const record=(await page).find(row=>row.id===ref.recordId),state=!record||record.kind!=='decision'||record.status!=='confirmed'||record.deletedAt!==undefined?'unavailable'
            :record.progress?.state==='completed'&&!record.progress.followUps?.length?'completed':'waiting';
        return {...ref,title:record?.title??ref.title,state};
    }));
}
