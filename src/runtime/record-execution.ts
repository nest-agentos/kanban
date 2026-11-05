import {cleanupRecordTasks} from './record-cleanup';
import {advanceRecordControl, requestRecordControl, recordControlKey, type RecordControl} from './record-controls';
import {DEFAULT_KANBAN_WORK_TYPES,projectKanbanTask} from '../contracts';
import {journalCommand} from './journal-command';
import {sha256HexSync} from '../utils';
import type {KanbanResourceCatalog} from './ports';
import type {KanbanBoard, KanbanClient, KanbanCommand, KanbanProjectRecord, KanbanRecordExecution, KanbanRecordRunRequest, KanbanItem} from '../contracts';
import {KanbanAutomationJournal} from './automation-journal';
import {requireValue} from '../rules';
import {safeCode} from './diagnostics';

interface SavedRun extends KanbanRecordExecution {
    previousRunId?:string;
    placement?: KanbanRecordRunRequest['placement']; requestRevision?: number; taskKind?: string; parentKind?: string;
    sourceBoardId: string; record: KanbanProjectRecord; automation: NonNullable<KanbanBoard['automation']>}
type RunReceipt = Pick<SavedRun, 'id' | 'sourceBoardId' | 'recordId' | 'recordRevision' | 'requestRevision' | 'placement'> & {schema?: 2};
interface Options {
    deliveryReady?(boardId:string,item:KanbanItem):Promise<boolean>;
    archiveItemResources?(boardId:string,itemId:string,operationId:string):Promise<void>;
    archiveSession?(sessionId:string,operationId:string):Promise<void>;
    planningSession?: KanbanClient['planningSession'];
    requiresItemResource?(board:KanbanBoard):boolean;
    service: KanbanClient; journal: KanbanAutomationJournal; resources: KanbanResourceCatalog;
    log(input: {operationId: string; boardId: string; stage: string; result: 'success' | 'failure'; code?: string; durationMs: number}): void;
}

/** A restartable projection from an approved decision into work on its chosen board. */
export function createRecordExecution(options: Options) {
    let stopped = false;
    const pending = new Map<string, Promise<KanbanRecordExecution>>();
    const resume = (run: SavedRun) => {
        requireValue(!stopped, 'SERVICE_STOPPING');
        let job = pending.get(run.id);
        if (!job) {job = advance(options, run).finally(() => {pending.delete(run.id);}); pending.set(run.id, job);}
        return job;
    };
    return {
        itemResources:async(boardId:string,parentId?:string)=>{
            const board=await options.service.read(boardId),parent=parentId?(await options.service.item(boardId,parentId)).item:undefined;
            const refs=parent?.externalRefs?.filter(ref=>ref.system===options.resources.system)??[];
            const resources=(await options.resources.list());
            return {resources,selected:refs.length===1?refs[0]:undefined,readonly:refs.length===1,required:refs.length===1||options.requiresItemResource?.(board)===true};
        },
        recordResources: async () => (await options.resources.list()),
        runRecord: async (boardId: string, request: KanbanRecordRunRequest) => {
            requireValue(!stopped, 'SERVICE_STOPPING');
            const started = Date.now(), operationId = sha256HexSync(JSON.stringify([boardId, request.operationId]));
            let run: SavedRun;
            try {
                run = await prepare(options, boardId, request);
                options.log({operationId, boardId, stage: 'record.prepare', result: 'success', durationMs: Date.now() - started});
            } catch (error) {
                options.log({operationId, boardId, stage: 'record.prepare', result: 'failure', code: safeCode(error, 'RECORD_PREPARATION_FAILED'), durationMs: Date.now() - started});
                throw error;
            }
            return resume(run);
        },
        controlRecord: async (boardId: string, request: Parameters<NonNullable<KanbanClient['controlRecord']>>[1]) => {
            await requestRecordControl(options.service, options.journal, boardId, request);
            if((await options.journal.get<RecordControl>(recordControlKey(boardId,request.recordId)))?.settled)return;
            for (const run of await options.journal.get<SavedRun[]>('record-runs:' + boardId) ?? []) if (run.recordId===request.recordId&&!['completed','failed','cancelled'].includes(run.state)) {
                await pending.get(run.id)?.catch(() => {}); await resume(run);
            }
            const runs = (await options.journal.get<SavedRun[]>('record-runs:' + boardId) ?? []).filter(run => run.recordId === request.recordId);
            if (['cancel','archive','delete','restart'].includes(request.action) && runs.every(run => ['completed','failed','cancelled'].includes(run.state))) await finishDecisionCancellation(options, boardId, request.recordId, request.operationId);
        },
        recordSessions: async(boardId:string,recordId:string,query?:{includeArchived?:boolean})=> {
            await options.service.record(boardId, recordId);
            const runs = await options.journal.get<SavedRun[]>('record-runs:' + boardId) ?? [];
            const targets = new Map(runs.filter(run=>run.recordId===recordId&&(query?.includeArchived||run.archivedAt===undefined)).flatMap(run => (run.itemIds ?? []).map(id => [JSON.stringify([run.boardId,id]), {board:run.boardId,id}] as const)));
            const sessions = await Promise.all([...targets.values()].map(row => options.planningSession?.(row.board,row.id)));
            return sessions.filter((row): row is NonNullable<typeof row> => !!row);
        },
        recordExecutions: async (boardId: string, recordId: string) => {
            await options.service.record(boardId, recordId);
            const runs = await options.journal.get<SavedRun[]>('record-runs:' + boardId) ?? [];
            return runs.filter(run => run.recordId === recordId).map(view);
        },
        async scan() {
            if (stopped) return;
            const errors: unknown[] = [];
            for (const board of await options.service.catalog()) {
                if (stopped) return;
                for (const run of await options.journal.get<SavedRun[]>('record-runs:' + board.id) ?? []) {
                    if (stopped) return;
                    if (!['completed', 'failed', 'cancelled'].includes(run.state)) {try {await resume(run);} catch (error) {errors.push(error);}}
                }
            }
            for (const row of await options.journal.find<RecordControl>('record-control:', value => value.action === 'cancel' && !value.settled)) {
                if (!row.value.boardId || !row.value.recordId) continue;
                try {await finishDecisionCancellation(options, row.value.boardId, row.value.recordId, row.value.operationId);} catch(error){errors.push(error);options.log({operationId:row.value.operationId,boardId:row.value.boardId,stage:'record.control.finalize',result:'failure',code:safeCode(error,'RECORD_CONTROL_FINALIZATION_FAILED'),durationMs:0});}
            }
            if (errors.length) throw new AggregateError(errors, 'RECORD_EXECUTION_SCAN_FAILED');
        },
        async quiesce() {stopped = true; await Promise.allSettled([...pending.values()]);},
    };
}

export async function validateResourceReferences(resources: KanbanResourceCatalog, record: Pick<KanbanProjectRecord, 'externalRefs'>): Promise<void> {
    const refs = record.externalRefs?.filter(ref => ref.system === resources.system) ?? [];
    requireValue(refs.length <= 16 && new Set(refs.map(ref => ref.id)).size === refs.length, 'INVALID_RESOURCE_SELECTION');
    await resources.validate(refs);
}

async function prepare(options: Options, boardId: string, request: KanbanRecordRunRequest): Promise<SavedRun> {
    requireValue(typeof request.operationId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(request.operationId), 'INVALID_OPERATION_ID');
    requireValue(!(await options.service.read(boardId)).lifecycle,'BOARD_STOPPING');
    const record = await options.service.record(boardId, request.recordId);
    const control = await options.journal.get<RecordControl>(recordControlKey(boardId, record.id));
    requireValue(record.deletedAt === undefined && record.archivedAt===undefined && (!control || control.action === 'resume' && control.settled || control.after==='restart'&&record.executionEpoch===control.operationId), 'RECORD_CONTROL_ACTIVE');
    const frozen = await options.journal.get<RunReceipt>('record-operation:' + request.operationId);
    if (frozen) {
        requireValue(frozen.sourceBoardId === boardId && frozen.recordId === request.recordId && (frozen.requestRevision ?? frozen.recordRevision) === request.expectedRevision
            && (!frozen.placement || frozen.placement === (request.placement ?? 'current-board')), 'IDEMPOTENCY_CONFLICT');
        const current = (await options.journal.get<SavedRun[]>('record-runs:' + boardId))?.find(run => run.id === frozen.id);
        requireValue(current, 'RECORD_EXECUTION_CHECKPOINT_MISSING');
        return freezeOperation(options, request, current);
    }
    requireValue(record.kind === 'decision' && record.status === 'confirmed', 'DECISION_NOT_CONFIRMED');
    requireValue(record.revision === request.expectedRevision, 'REVISION_CONFLICT');
    const board = await options.service.read(boardId);
    requireValue(board.automation, 'AUTOMATION_BINDING_REQUIRED');
    await validateResourceReferences(options.resources, record);
    requireValue(record.externalRefs?.some(ref => ref.system === options.resources.system), 'REMOTE_PROJECT_REQUIRED');
    const id = sha256HexSync(JSON.stringify([boardId, record.id, record.revision]));
    const placement = request.placement ?? 'current-board';
    requireValue(['current-board', 'new-board'].includes(placement), 'INVALID_EXECUTION_PLACEMENT');
    const saved = await options.journal.update<SavedRun[]>('record-runs:' + boardId, previous => {
        requireValue(control?.after==='restart'&&record.executionEpoch===control.operationId||!previous?.some(row=>row.recordId===record.id&&row.state==='completed'),'DECISION_EXECUTION_COMPLETED');
        const same = previous?.find(row => row.id === id || row.recordId === record.id && decisionSignature(row.record) === decisionSignature(record));
        if (same) {requireValue(!same.placement || same.placement === placement, 'DECISION_EXECUTION_PLACEMENT_CONFLICT'); return previous!;}
        requireValue(!previous?.some(row => row.recordId === record.id && !['completed','failed','cancelled'].includes(row.state)), 'DECISION_EXECUTION_UNSETTLED');
        requireValue((previous?.length ?? 0) < 100, 'RECORD_EXECUTION_LIMIT');
        const candidate=newRun(board,record,request,id,options.resources.system);
        if(control?.after==='restart')candidate.previousRunId=previous?.filter(row=>row.recordId===record.id).sort((a,b)=>b.createdAt-a.createdAt)[0]?.id;
        return [...previous??[],candidate];
    });
    await options.journal.update('record-context:'+id,old=>old??{sourceBoardId:boardId,recordId:record.id,recordRevision:record.revision,runId:id,previousRunId:saved.find(run=>run.id===id)?.previousRunId});
    const original = saved.find(row => row.id === id || row.recordId === record.id && decisionSignature(row.record) === decisionSignature(record))!;
    return freezeOperation(options, request, original);
}
async function freezeOperation(options: Options, request: KanbanRecordRunRequest, run: SavedRun): Promise<SavedRun> {
    await options.journal.update<RunReceipt>('record-operation:' + request.operationId, previous => {
        requireValue(!previous || previous.id === run.id && (previous.requestRevision ?? previous.recordRevision) === request.expectedRevision
            && (!previous.placement || previous.placement === (request.placement ?? 'current-board')), 'IDEMPOTENCY_CONFLICT');
        return {schema: 2, id: run.id, sourceBoardId: run.sourceBoardId, recordId: run.recordId,
            recordRevision: run.recordRevision, requestRevision: request.expectedRevision, ...(run.placement ? {placement: run.placement} : {})};
    });
    return run;
}

async function advance(options: Options, run: SavedRun): Promise<KanbanRecordExecution> {
    const started = Date.now();
    try {
        const control = await options.journal.get<RecordControl>(recordControlKey(run.sourceBoardId, run.recordId));
        if (control && !control.settled && !(control.after==='restart'&&run.record.executionEpoch===control.operationId)) {
            const state = await advanceRecordControl(options.service, options.journal, run, control);
            const updated = await save(options, {...run, state, updatedAt: Date.now()});
            if (state !== run.state) options.log({operationId:control.operationId, boardId:run.sourceBoardId, stage:'record.control.' + control.action, result:state==='unknown'||state==='blocked'?'failure':'success', code:updated.code, durationMs:Date.now()-started});
            if (control.action === 'resume' && state === 'running') {
                const runs = await options.journal.get<SavedRun[]>('record-runs:' + run.sourceBoardId);
                if (runs?.filter(row => row.recordId === run.recordId).every(row => ['running','completed','failed','cancelled'].includes(row.state))) await options.journal.update<RecordControl>(recordControlKey(run.sourceBoardId, run.recordId), old => ({...old!, settled: true}));
            }
            if (state === 'cancelled') {
                const runs = await options.journal.get<SavedRun[]>('record-runs:' + run.sourceBoardId);
                if (runs?.filter(row => row.recordId === run.recordId).every(row => ['completed','failed','cancelled'].includes(row.state))) await finishDecisionCancellation(options, run.sourceBoardId, run.recordId, control.operationId);
            }
            return view(updated);
        }
        await validateResourceReferences(options.resources, run.record);
        await materialize(options, run);
        const board = await options.service.read(run.boardId);
        const items = run.itemIds ? await Promise.all(run.itemIds.map(async id => board.items.find(item => item.id === id) ?? (await options.service.item(run.boardId, id)).item)) : board.items;
        if(run.rootItemId&&!run.itemIds?.includes(run.rootItemId)&&items.every(item=>item.purpose!=='planning')&&board.items.find(item=>item.id===run.rootItemId)?.purpose==='planning')await once(options,run,'finish-planning',{type:'finish-planning',itemId:run.rootItemId});
        const stage=items.some(item=>item.purpose==='planning')?'planning' as const:'execution' as const;
        let state=runState(items);
        if(state==='completed'&&options.deliveryReady&&!(await Promise.all(items.map(item=>options.deliveryReady!(run.boardId,item)))).every(Boolean))state='review';
        if (state === 'completed' && run.rootItemId && !run.itemIds?.includes(run.rootItemId) && board.items.find(item => item.id === run.rootItemId)?.status !== 'completed') {
            await once(options, run, 'close-root', {type: 'close-plan', itemId: run.rootItemId, resultRef: 'kanban-run:' + run.id});
        }
        if(state==='completed'&&run.rootItemId&&!run.itemIds?.includes(run.rootItemId)&&options.deliveryReady&&!await options.deliveryReady(run.boardId,(await options.service.item(run.boardId,run.rootItemId)).item))state='review';
        const code = state === 'failed' ? 'DECISION_TASK_CANCELLED' : state === 'blocked' && items.some(item=>projectKanbanTask(item).phase==='waiting-input') ? 'DECISION_INPUT_REQUIRED' : undefined;
        if (run.state===state&&run.code===code&&run.stage===stage) return view(run);
        const updated = await save(options, {...run,state,code,stage,updatedAt: Date.now()});
        options.log({operationId: run.id, boardId: run.sourceBoardId, stage: 'record.run', result: state === 'failed' ? 'failure' : 'success', code: updated.code, durationMs: Date.now() - started});
        return view(updated);
    } catch (error) {
        const code = safeCode(error, 'RECORD_EXECUTION_FAILED');
        if (code === 'SERVICE_STOPPING') throw error;
        await save(options, {...run, state: 'blocked', code, updatedAt: Date.now()});
        options.log({operationId: run.id, boardId: run.sourceBoardId, stage: 'record.run', result: 'failure', code, durationMs: Date.now() - started});
        throw error;
    }
}

function decisionSignature(record: KanbanProjectRecord): string {
    return sha256HexSync(JSON.stringify([record.title, record.content, record.rationale, record.externalRefs,record.completion,record.executionEpoch]));
}
function newRun(board: KanbanBoard, record: KanbanProjectRecord, request: KanbanRecordRunRequest, id: string, resourceSystem: string): SavedRun {
    const placement = request.placement ?? 'current-board';
    requireValue(['current-board', 'new-board'].includes(placement), 'INVALID_EXECUTION_PLACEMENT');
    requireValue(placement === 'new-board' || board.automation?.enabled, 'AUTOMATION_PAUSED');
    const refs = record.externalRefs!.filter(ref => ref.system === resourceSystem);
    const types = board.workTypes ?? DEFAULT_KANBAN_WORK_TYPES;
    const task = types.find(type => type.id === (board.defaultWorkType ?? 'task') && type.executable) ?? types.find(type => type.executable);
    const parent = types.filter(type => !type.executable && type.rank < (task?.rank ?? 0)).sort((a, b) => b.rank - a.rank)[0];
    requireValue(task && (refs.length === 1 || parent), 'DECISION_WORK_TYPES_REQUIRED');
    const itemIds = refs.map((_, index) => 'work-' + id + '-' + index);
    return {id, sourceBoardId: board.id, recordId: record.id, recordRevision: record.revision,
        boardId: placement === 'new-board' ? 'run-' + id : board.id, placement, taskKind: task.id, parentKind: parent?.id,
        rootItemId: refs.length === 1 ? itemIds[0] : 'feature-' + id, itemIds,
        state:'preparing',stage:'planning',createdAt: Date.now(), updatedAt: Date.now(), record, automation: structuredClone(board.automation!)};
}
function runState(items: KanbanItem[]): KanbanRecordExecution['state'] {
    if (items.some(item => item.status === 'cancelled')) return 'failed';
    if (items.length && items.every(item => item.status === 'completed')) return 'completed';
    if (items.some(item => item.blocked || projectKanbanTask(item).phase === 'waiting-input')) return 'blocked';
    return items.length && items.every(item => ['completed', 'review'].includes(item.status)) ? 'review' : 'running';
}
async function materialize(options: Options, run: SavedRun): Promise<void> {
    if (run.boardId !== run.sourceBoardId) {
        const actor = await options.service.currentPrincipal(), source = await options.service.read(run.sourceBoardId);
        await options.service.create({id: run.boardId, title: run.record.title, scope: {kind: 'collection', namespace: 'decision-run', id: run.id},
            members: [{...actor, responsibility: 'Review decision execution', roles: ['coordinator', 'reviewer', 'worker']}],
            ...(run.placement && source.workTypes ? {workTypes: source.workTypes, defaultWorkType: source.defaultWorkType} : {}),
            policy: {requireEstimate: false, review: 'independent'}});
    }
    const refs = run.record.externalRefs!.filter(ref => ref.system === options.resources.system);
    const group = !!run.rootItemId && !run.itemIds?.includes(run.rootItemId);
    if (group) await once(options, run, 'root', {type: 'create-item', item: {id: run.rootItemId!, title: run.record.title,
        responsibility: run.record.content, acceptance: run.record.rationale ?? run.record.content,purpose:'planning'},
        planning: {kind: run.parentKind!, priority: 2, dependencies: [], references: []}});
    for (const [index, reference] of refs.entries()) {
        await once(options, run, 'item-' + index, {type: 'create-item', item: {id: run.itemIds?.[index] ?? 'work-' + index,
            title: run.record.title, responsibility: run.record.content, acceptance: run.record.rationale ?? run.record.content,purpose:'planning',
            externalRefs: [reference, {system: options.resources.decisionSystem ?? 'kanban-decision', id: run.id}]},
            ...(run.taskKind ? {planning: {kind: run.taskKind, priority: 2, dependencies: [], references: [], ...(group ? {parentId: run.rootItemId} : {})}} : {})});
    }
    await markPlanning(options,run);
    if (run.boardId !== run.sourceBoardId) await once(options, run, 'automation', {type: 'configure-automation', settings: {...run.automation, enabled: true, autoAccept: false}});
    if (run.rootItemId && run.boardId === run.sourceBoardId) await once(options, run, 'link-root', {type: 'link-record', recordId: run.recordId, itemId: run.rootItemId});
}

async function once(options: Options, run: SavedRun, stage: string, command: KanbanCommand): Promise<void> {
    const key = 'record-stage:' + run.id + ':' + stage;
    await journalCommand(options.journal, options.service, run.boardId, key, command);
}
async function save(options: Options, run: SavedRun): Promise<SavedRun> {
    const rows = await options.journal.update<SavedRun[]>('record-runs:' + run.sourceBoardId, previous => {
        const current = previous ?? [];
        requireValue(current.some(row => row.id === run.id), 'RECORD_EXECUTION_CHECKPOINT_MISSING');
        return current.map(row => row.id !== run.id || row.state===run.state&&row.code===run.code&&row.stage===run.stage ? row:run);
    });
    return rows.find(row => row.id === run.id)!;
}

function view(run: SavedRun): KanbanRecordExecution {
    const {id, recordId, recordRevision, boardId, rootItemId, itemIds, state, createdAt, updatedAt,archivedAt,stage,code} = run;
    return {id, recordId, recordRevision, boardId, ...(rootItemId ? {rootItemId, itemIds} : {}), state,createdAt,updatedAt,...(stage?{stage}:{}),...(archivedAt!==undefined?{archivedAt}:{}), ...(code ? {code} : {})};
}

async function cancelDecision(options: Options, boardId: string, recordId: string, operationId: string): Promise<void> {
    const record = await options.service.record(boardId, recordId);
    if (record.status !== 'cancelled') await journalCommand(options.journal, options.service, boardId, 'record-cancel:' + JSON.stringify([boardId,recordId,operationId]), {type: 'cancel-record', recordId});

}

async function finishDecisionCancellation(options: Options, boardId: string, recordId: string, operationId: string): Promise<void> {
    const started=Date.now(),control=await options.journal.get<RecordControl>(recordControlKey(boardId,recordId));
    requireValue(control,'RECORD_CONTROL_ACTIVE');if(control.settled)return;
    const runs=(await options.journal.get<SavedRun[]>('record-runs:'+boardId)??[]).filter(run=>run.recordId===recordId&&!(control.after==='restart'&&run.record.executionEpoch===control.operationId));
    if(runs.some(run=>!['completed','failed','cancelled'].includes(run.state)))return;
    const record=await options.service.record(boardId,recordId);
    if(record.executionEpoch!==control.operationId){
        const state=await advanceRecordControl(options.service,options.journal,{id:operationId,sourceBoardId:boardId,boardId,recordId,recordRevision:record.revision,itemIds:record.itemIds,state:'cancelling',createdAt:0,updatedAt:0},control);
        if(state!=='cancelled')return;
        await cancelDecision(options,boardId,recordId,operationId);
    }
    if(control.after)await cleanupRecordTasks(options.service,options.journal,runs,control.after==='delete'?'delete':'archive',operationId,options.archiveSession,options.planningSession,options.archiveItemResources);
    if(control.after)await options.journal.update<SavedRun[]>('record-runs:'+boardId,old=>(old??[]).map(row=>runs.some(run=>run.id===row.id)?{...row,archivedAt:row.archivedAt??Date.now()}:row));
    if(control.after==='restart')await restartDecision(options,boardId,recordId,operationId);
    else if(control.after)await journalCommand(options.journal,options.service,boardId,'record-dispose:'+operationId,{type:control.after==='delete'?'delete-record':'archive-record',recordId});
    await options.journal.update<RecordControl>(recordControlKey(boardId,recordId),old=>({...old!,settled:true}));
    options.log({operationId,boardId,stage:'record.control.'+(control.after??'cancel')+'.settled',result:'success',durationMs:Date.now()-started});
}
async function restartDecision(options:Options,boardId:string,recordId:string,operationId:string):Promise<void> {
    await journalCommand(options.journal,options.service,boardId,'record-restart:'+operationId,{type:'restart-record',recordId,epoch:operationId});
    const record=await options.service.record(boardId,recordId);
    const existing=(await options.journal.get<SavedRun[]>('record-runs:'+boardId))?.find(run=>run.recordId===recordId&&run.record.executionEpoch===operationId);
    const run=await prepare(options,boardId,{recordId,operationId:'restart-'+operationId,expectedRevision:existing?.requestRevision??existing?.recordRevision??record.revision});
    await advance(options,run);
}

async function markPlanning(options:Options,run:SavedRun):Promise<void> {
    const workflow=await options.service.workflow(run.boardId);
    for(const id of run.itemIds??[]){
        if(Object.values(workflow.plans).some(plan=>plan.rootItemId===id||plan.itemIds.includes(id)))continue;
        const {item}=await options.service.item(run.boardId,id);
        if(item.purpose==='planning'||item.owner||!['backlog','open'].includes(item.status))continue;
        await journalCommand(options.journal,options.service,run.boardId,'record-planning-marker:'+run.id+':'+id,{type:'mark-planning',itemId:id});
    }
}
