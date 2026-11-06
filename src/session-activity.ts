import type {KanbanBoard, KanbanCommand, KanbanActor, KanbanService, KanbanExecutionSession, KanbanExternalReference, KanbanSessionItemSummary, KanbanWorkflowState} from './contracts';
import type {KanbanSessionSource} from './activity-ports';
import {principal,principalKey,candidates} from './identity';
import {KanbanError} from './ports';
import {querySessionItems} from './session-activity-query';
import {randomUUID} from './utils';
import {sessionAssociations, projectRelatedSessions} from './session-relations';
export interface KanbanSessionActivityOptions {source: KanbanSessionSource; now?:()=>number}
export function executionBindings(refs: KanbanExternalReference[] | undefined, referenceSystem: string) {return (refs ?? []).filter(ref=>ref.system===referenceSystem);}
function currentBinding(refs: KanbanExternalReference[]|undefined, itemId:string, workflow:KanbanWorkflowState, referenceSystem: string,epoch?:string) {
    if(epoch&&!Object.values(workflow.dispatches).some(row=>row.itemId===itemId&&row.executionEpoch===epoch))return undefined;
    const binding=executionBindings(refs, referenceSystem).at(-1),latest=Object.values(workflow.dispatches).filter(dispatch=>dispatch.itemId===itemId&&dispatch.executionEpoch===epoch).sort((a,b)=>b.attempt-a.attempt)[0];
    if(!binding||!latest||binding.revision===latest.id) return binding;
    return ['prepared','running','unknown','succeeded'].includes(latest.outcome)||workflow.dispatches[binding.revision ?? '']?undefined:binding;
}

/** Optional resource projection; access checks remain owned by the injected source. */
export function createKanbanSessionActivity(core: KanbanService, options: KanbanSessionActivityOptions | undefined, log: (event: {operationId:string;sessionId?:string;stage:string;result:'failure';code:string;durationMs:number})=>void, referenceSystem: string) {
    const inspect=createSessionInspector(options,log);
    const project=async(boardId:string,rows:KanbanSessionItemSummary[])=>{
        if(!rows.some(row=>executionBindings(row.externalRefs,referenceSystem).length))return rows;
        const [board,workflow]=await Promise.all([boardMetadata(core,boardId),core.workflow(boardId)]), bindings=new Map(rows.map(row=>[row.id,currentBinding(row.externalRefs,row.id,workflow,referenceSystem,row.executionEpoch)]));
        const ids=[...new Set([...bindings.values()].flatMap(ref=>ref?[ref.id]:[]))], states=new Map<string,KanbanExecutionSession>();let next=0;
        await Promise.all(Array.from({length:Math.min(ids.length,8)},async()=>{while(next<ids.length) {const id=ids[next++];states.set(id,await inspect(board,id));}}));
        return rows.map(row=>{const binding=bindings.get(row.id);return {...row,...(binding?{execution:states.get(binding.id)}: {})};});
    };
    return {
        queryActivity:(boardId:string,query:import('./contracts').KanbanSessionActivityQuery={})=>querySessionItems(core,boardId,query,rows=>project(boardId,rows)),
        async executionSession(boardId:string,itemId:string, query: import('./contracts').KanbanSessionDetailQuery = {}) {
            const started = Date.now();
            if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key => key !== 'includeRelated') || query.includeRelated !== undefined && typeof query.includeRelated !== 'boolean') throw new KanbanError('INVALID_QUERY');
            const {item}=await core.item(boardId,itemId),bindings=executionBindings(item.externalRefs,referenceSystem);
            if(!bindings.length && !query.includeRelated)return {history:[]};
            const [board,workflow]=await Promise.all([boardMetadata(core,boardId),core.workflow(boardId)]),last=currentBinding(item.externalRefs,itemId,workflow,referenceSystem,item.executionEpoch);
            let sessionsCode: string | undefined;
            const related = query.includeRelated ? await options?.source.related?.(board, item, workflow).catch(error => {
                const candidate = (error as {code?: string})?.code;
                sessionsCode = candidate && /^[A-Z][A-Z0-9_]{0,79}$/.test(candidate) ? candidate : 'SESSION_RELATIONS_FAILED';
                try {log({operationId: randomUUID(), stage: 'session.relations', result: 'failure', code: sessionsCode, durationMs: Date.now() - started});} catch { /* Diagnostics cannot hide known associations. */ }
                return [];
            }) : [];
            const sessions = query.includeRelated ? await projectRelatedSessions([
                ...sessionAssociations(item, bindings, workflow), ...related ?? [],
            ], last?.id, id => inspect(board, id)) : undefined;
            return {current:last?(sessions?.find(row=>row.sessionId===last.id) ?? await inspect(board,last.id)):undefined,
                history:bindings.map(ref=>({sessionId:ref.id,bindingId:ref.revision,current:ref===last})).reverse(), ...(sessions ? {sessions} : {}), ...(sessionsCode ? {sessionsCode} : {})};
        },
        validate:(board:KanbanBoard,command:KanbanCommand|undefined,actor:KanbanActor)=>validateBinding(core,options,board,command,actor,referenceSystem),
    };
}
function createSessionInspector(options:KanbanSessionActivityOptions|undefined,log:Parameters<typeof createKanbanSessionActivity>[2]) {
    const now=options?.now ?? Date.now, cache=new Map<string,KanbanExecutionSession>();
    return async(board:KanbanBoard,sessionId:string):Promise<KanbanExecutionSession>=>{
        const started=now(),key=JSON.stringify([board.id,sessionId]);
        try {
            if(!options) throw new KanbanError('EXECUTION_SESSION_UNAVAILABLE');
            const row=await options.source.inspect(board,sessionId);
            if(row.sessionId!==sessionId) throw new KanbanError('SESSION_ACTIVITY_SCOPE_MISMATCH');
            const stale=row.stale||row.observedAt===undefined||now()-row.observedAt>90000;
            const value:KanbanExecutionSession={sessionId,...(typeof row.resourceId==='string'&&row.resourceId.length<=4096&&!row.resourceId.includes('\0')?{resourceId:row.resourceId}:{}),title:row.title?.slice(0,256),state:row.state,createdAt:row.createdAt,lastActivityAt:row.lastActivityAt,observedAt:row.observedAt,stale,
                recent:!stale&&row.lastActivityAt!==undefined&&row.lastActivityAt<=now()&&now()-row.lastActivityAt<=600000,...(row.code&&/^[A-Z][A-Z0-9_]{0,79}$/.test(row.code)?{code:row.code}:{})};
            if(cache.size>=256) cache.delete(cache.keys().next().value!);cache.set(key,value);return value;
        } catch(error) {
            const candidate=(error as {code?:string})?.code,code=candidate&&/^[A-Z][A-Z0-9_]{0,79}$/.test(candidate)?candidate:'SESSION_ACTIVITY_FAILED';
            try {log({operationId:randomUUID(),sessionId,stage:'session.activity',result:'failure',code,durationMs:now()-started});} catch { /* Observation diagnostics cannot change assignments. */ }
            const prior=['EIO','ETIMEDOUT','ECONNRESET','ECONNREFUSED','SESSION_ACTIVITY_FAILED'].includes(code)?cache.get(key):undefined;
            return {...prior,sessionId,state:prior?.state ?? 'unknown',stale:true,recent:false,code};
        }
    };
}
async function boardMetadata(core: KanbanService, boardId: string): Promise<KanbanBoard> {
    const board=(await core.catalog()).find(board=>board.id===boardId) ?? await core.read(boardId);
    return {...board,items:[]};
}
async function validateBinding(core: KanbanService, options:KanbanSessionActivityOptions|undefined, board:KanbanBoard, command:KanbanCommand|undefined, actor:KanbanActor, referenceSystem: string): Promise<void> {
    if(command?.type!=='link-reference'||command.reference.system!==referenceSystem) return;
    if(!options||!command.reference.revision) throw new KanbanError('EXECUTION_SESSION_UNAVAILABLE');
    const item=board.items.find(item=>item.id===command.itemId);if(!item) throw new KanbanError('ITEM_NOT_FOUND');
    const key=principalKey(principal(actor)), coordinator=board.members?.some(member=>principalKey(member)===key&&member.roles?.includes('coordinator'));
    if(!coordinator&&item.owner?.principalId!==key&&!(item.owner===undefined&&candidates(board,item).some(candidate=>principalKey(candidate)===key))) throw new KanbanError('EXECUTION_SESSION_ASSIGNMENT_DENIED');
    const active=Object.values((await core.workflow(board.id)).dispatches).filter(dispatch=>dispatch.itemId===item.id).sort((a,b)=>b.attempt-a.attempt)[0];
    if(active&&command.reference.revision!==active.id) throw new KanbanError('EXECUTION_SESSION_LOCKED');
    if(active&&executionBindings(item.externalRefs,referenceSystem).some(ref=>ref.revision===active.id&&ref.id!==command.reference.id)) throw new KanbanError('EXECUTION_SESSION_LOCKED');
    if(options.source.authorizeBinding) return options.source.authorizeBinding(board,command.reference.id);
    const state=await options.source.inspect(board,command.reference.id);
    if(state.sessionId!==command.reference.id||state.stale) throw new KanbanError('EXECUTION_SESSION_UNAVAILABLE');
}
