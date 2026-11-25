import {forEachRecordScope} from './record-read-scopes';
import {withRecordProgress} from './record-progress';
import {validateDecisionDependencies,decisionDependencyStates} from './record-dependencies';
import type {DecisionContext} from './work-context';
import {kanbanVerificationMode} from '../contracts/verification';
import {isRecurringTask} from '../contracts/references';
import {recordArchival} from './record-archive';
import {cleanupRecordTasks} from './record-cleanup';
import {advanceRecordControl, requestRecordControl, recordControlKey, type RecordControl} from './record-controls';
import {DEFAULT_KANBAN_WORK_TYPES,projectKanbanTask,kanbanReference} from '../contracts';
import {journalCommand} from './journal-command';
import {sha256HexSync} from '../utils';
import type {KanbanResourceCatalog} from './ports';
import type {KanbanBoard, KanbanClient, KanbanCommand, KanbanProjectRecord, KanbanRecordExecution, KanbanRecordRunRequest, KanbanItem} from '../contracts';
import {KanbanAutomationJournal} from './automation-journal';
import {requireValue} from '../rules';
import {safeCode} from './diagnostics';
import {recurrenceIntentKey,type RecurrenceIntent} from './recurrence-admission';

interface SavedRun extends KanbanRecordExecution {
    recurring?:true;
    sharedCoordination?:true;
    settings?:Record<string,string>;
    previousRunId?:string;
    placement?: KanbanRecordRunRequest['placement']; requestRevision?: number; taskKind?: string; parentKind?: string;
    sourceBoardId: string; record: KanbanProjectRecord; automation: NonNullable<KanbanBoard['automation']>}
type RunReceipt = Pick<SavedRun, 'id' | 'sourceBoardId' | 'recordId' | 'recordRevision' | 'requestRevision' | 'placement'> & {schema?: 2};
interface Options {
    projectManagementTask?(boardId:string,itemId:string,task:import('../contracts').KanbanTaskProjection):Promise<import('../contracts').KanbanTaskProjection>;
    dependencyRecords?(board:string):Promise<import('../contracts').KanbanRecordSummary[]>;
    dismissAttention?(boardId:string,request:Parameters<NonNullable<KanbanClient['controlRecord']>>[1]):Promise<void>;
    archiveItemResources?(boardId:string,itemId:string,operationId:string):Promise<void>;
    archiveSession?(sessionId:string,operationId:string):Promise<void>;
    planningSession?: KanbanClient['planningSession'];
    requiresItemResource?(board:KanbanBoard):boolean;
    service: KanbanClient; journal: KanbanAutomationJournal; resources: KanbanResourceCatalog;
    log(input: {operationId: string; boardId: string; stage: string; result: 'success' | 'failure'; code?: string; durationMs: number}): void;
}
export type RecordRecurringRunner=(intent:RecurrenceIntent)=>Promise<KanbanRecordExecution>;

/** A restartable projection from an approved decision into work on its chosen board. */
export function createRecordExecution(options: Options) {
    const archival=recordArchival(options.service,options.journal,options.log);
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
            const resources=(await options.resources.list()).filter(resource=>!refs.length||refs.some(ref=>ref.system===resource.reference.system&&ref.id===resource.reference.id));
            return {resources,selected:refs.length===1?refs[0]:undefined,readonly:refs.length===1,required:refs.length===1||options.requiresItemResource?.(board)===true};
        },
        recordDelivery:async(boardId:string,itemId:string)=>{
            const item=(await options.service.item(boardId,itemId)).item;
            const reference=item.externalRefs?.find(row=>row.system===(options.resources.decisionSystem??'kanban-decision'));if(!reference)return;
            let context=await options.journal.get<DecisionContext>('record-context:'+reference.id);
            if(!context){const run=await options.journal.run<SavedRun>(boardId,reference.id);if(run)context={sourceBoardId:run.sourceBoardId,recordId:run.recordId,recordRevision:run.recordRevision,runId:run.id};}
            if(!context)return;
            const record=await options.service.record(context.sourceBoardId,context.recordId);
            const actor=await options.service.currentPrincipal(),source=await options.service.read(context.sourceBoardId);
            const member=source.members?.some(row=>row.kind===actor.kind&&row.id===actor.id&&row.roles?.some(role=>role==='reviewer'||role==='coordinator'));
            const editable=actor.kind==='human'&&!!member&&record.archivedAt===undefined&&record.deletedAt===undefined&&record.status!=='cancelling';
            return {boardId:context.sourceBoardId,recordId:record.id,revision:record.revision,mode:kanbanVerificationMode(record),editable,...(!editable?{code:'DECISION_NOT_EDITABLE'}:{})};
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
        runRecurring:async(intent:RecurrenceIntent)=>{
            requireValue(!stopped,'SERVICE_STOPPING');
            const frozen=intent.layout==='row'?await options.journal.get<RecurrenceIntent>(recurrenceIntentKey(intent.id)):(await options.journal.get<RecurrenceIntent[]>('recurrence-admission:'+JSON.stringify([intent.boardId,intent.recordId])))?.find(row=>row.id===intent.id);
            requireValue(frozen?.phase==='submitting'&&JSON.stringify(frozen)===JSON.stringify(intent),'RECURRENCE_INTENT_INVALID');
            const current=await options.service.record(intent.boardId,intent.recordId);
            const reservation=current.recurrenceFence?.pending.find(row=>row.id===intent.id);
            requireValue(reservation&&reservation.configRevision===intent.configRevision&&reservation.scheduledAt===intent.scheduledAt&&JSON.stringify(reservation.record)===JSON.stringify(intent.record),'RECURRENCE_RESERVATION_MISSING');
            const request={operationId:intent.id,recordId:intent.recordId,expectedRevision:intent.record.revision};
            return resume(await prepare(options,intent.boardId,request,frozen));
        },
        controlRecord: async (boardId: string, request: Parameters<NonNullable<KanbanClient['controlRecord']>>[1]) => {
            const started=Date.now();
            if(request.action==='archive')return archival.archive(boardId,request);
            if(request.action==='dismiss-attention'){requireValue(options.dismissAttention,'RECORD_CONTROL_UNAVAILABLE');return options.dismissAttention(boardId,request);}
            if(await requestRecordControl(options.service, options.journal, boardId, {...request,action:request.action})==='settled'){
                options.log({operationId:request.operationId,boardId,stage:'record.delete.unstarted',result:'success',durationMs:Date.now()-started});return;
            }
            if((await options.journal.get<RecordControl>(recordControlKey(boardId,request.recordId)))?.settled)return;
            for (const run of await options.journal.activeRecordRuns<SavedRun>(boardId,request.recordId)) {
                await pending.get(run.id)?.catch(() => {}); await resume(run);
            }
            const runs = await options.journal.activeRecordRuns<SavedRun>(boardId,request.recordId);
            if (['cancel','archive','delete','restart'].includes(request.action) && !runs.length) await finishDecisionCancellation(options, boardId, request.recordId, request.operationId);
        },
        recordSessions: async(boardId:string,recordId:string,query?:{includeArchived?:boolean})=> {
            await options.service.record(boardId, recordId);
            const runs = await options.journal.runSummaries(boardId,recordId);
            const targets = new Map(runs.filter(run=>run.recordId===recordId&&!run.code?.startsWith('DECISION_DEPENDENCY_')&&(query?.includeArchived||run.archivedAt===undefined)).flatMap(run => (run.itemIds ?? []).map(id => [JSON.stringify([run.boardId,id]), {board:run.boardId,id}] as const)));
            const sessions = await Promise.all([...targets.values()].map(row => options.planningSession?.(row.board,row.id)));
            return sessions.filter((row): row is NonNullable<typeof row> => !!row);
        },
        recordExecutions: async (boardId: string, recordId: string, query?:{includeManagementTasks?:boolean}) => {
            await options.service.record(boardId, recordId);
            const runs = await options.journal.runSummaries(boardId,recordId);
            const projected=runs.filter(run => run.recordId === recordId).map(view);
            if(query?.includeManagementTasks)await attachManagementTasks(options,projected);
            return projected;
        },
        recordExecutionPage:async(boardId:string,recordId:string,query?:{limit?:number;cursor?:string;includeManagementTasks?:boolean|'page'})=>{
            if((await options.service.record(boardId,recordId)).kind!=='decision')return {items:[],active:[]};
            const page=await options.journal.runHistoryPage(boardId,recordId,query?.limit??20,query?.cursor);
            const active=page.active.map(view);
            const items=page.items.map(view);
            if(query?.includeManagementTasks)await attachManagementTasks(options,query.includeManagementTasks==='page'?[...active,...items]:active, query.includeManagementTasks==='page');
            return {...page,items,active};
        },
        async scan() {
            if (stopped) return;
            const errors: unknown[] = [];
            for (const board of await options.service.catalog()) {
                if (stopped) return;
                for (const run of await options.journal.activeRuns<SavedRun>(board.id)) {
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
        async quiesce() {stopped = true; await Promise.allSettled([archival.quiesce(),...pending.values()]);},
    };
}

export async function validateResourceReferences(resources: KanbanResourceCatalog, record: Pick<KanbanProjectRecord, 'externalRefs'>): Promise<void> {
    const refs = record.externalRefs?.filter(ref => ref.system === resources.system) ?? [];
    requireValue(refs.length <= 16 && new Set(refs.map(ref => ref.id)).size === refs.length, 'INVALID_RESOURCE_SELECTION');
    await resources.validate(refs);
}

async function prepare(options: Options, boardId: string, request: KanbanRecordRunRequest,round?:RecurrenceIntent): Promise<SavedRun> {
    requireValue(typeof request.operationId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(request.operationId), 'INVALID_OPERATION_ID');
    requireValue(!(await options.service.read(boardId)).lifecycle,'BOARD_STOPPING');
    const current = await options.service.record(boardId, request.recordId),record=round?.record??current;
    const control = await options.journal.get<RecordControl>(recordControlKey(boardId, record.id));
    requireValue(current.deletedAt === undefined && current.archivedAt===undefined && (!control || control.action === 'resume' && control.settled || control.after==='restart'&&record.executionEpoch===control.operationId), 'RECORD_CONTROL_ACTIVE');
    const frozen = await options.journal.get<RunReceipt>('record-operation:' + request.operationId);
    if (frozen) {
        requireValue(frozen.sourceBoardId === boardId && frozen.recordId === request.recordId && (frozen.requestRevision ?? frozen.recordRevision) === request.expectedRevision
            && (!frozen.placement || frozen.placement === (request.placement ?? 'current-board')), 'IDEMPOTENCY_CONFLICT');
        const current = await options.journal.run<SavedRun>(boardId,frozen.id);
        requireValue(current, 'RECORD_EXECUTION_CHECKPOINT_MISSING');
        return freezeOperation(options, request, current);
    }
    requireValue(current.kind === 'decision' && current.status === 'confirmed' && record.status==='confirmed', 'DECISION_NOT_CONFIRMED');
    requireValue(round||record.revision === request.expectedRevision, 'REVISION_CONFLICT');
    const board = await options.service.read(boardId);
    requireValue(board.automation, 'AUTOMATION_BINDING_REQUIRED');
    await validateResourceReferences(options.resources, record);
    requireValue(record.externalRefs?.some(ref => ref.system === options.resources.system), 'REMOTE_PROJECT_REQUIRED');
    const id = round?.id??sha256HexSync(JSON.stringify([boardId, record.id, record.revision]));
    const placement = request.placement ?? 'current-board';
    requireValue(['current-board', 'new-board'].includes(placement), 'INVALID_EXECUTION_PLACEMENT');
    if(round){
        const candidate:SavedRun={...newRun(board,record,request,id),recurring:true,scheduledAt:round.scheduledAt,recurrenceRevision:round.configRevision};
        const context={sourceBoardId:boardId,recordId:record.id,recordRevision:record.revision,runId:id};
        return freezeOperation(options,request,await options.journal.appendRecurringRun(boardId,candidate,context));
    }
    if(record.hadRecurrence&&control?.after==='restart'){
        const existing=await options.journal.run<SavedRun>(boardId,id);
        if(existing){requireValue(existing.recordId===record.id&&existing.record.executionEpoch===control.operationId,'IDEMPOTENCY_CONFLICT');return freezeOperation(options,request,existing);}
        const page=await options.journal.runHistoryPage(boardId,record.id,1);
        const candidate:SavedRun={...newRun(board,record,request,id),previousRunId:page.items[0]?.id};
        const context={sourceBoardId:boardId,recordId:record.id,recordRevision:record.revision,runId:id,previousRunId:candidate.previousRunId};
        return freezeOperation(options,request,await options.journal.appendRecurringRun(boardId,candidate,context));
    }
    const saved = await options.journal.update<SavedRun[]>('record-runs:' + boardId, previous => {
        requireValue(round||control?.after==='restart'&&record.executionEpoch===control.operationId||!previous?.some(row=>row.recordId===record.id&&row.state==='completed'),'DECISION_EXECUTION_COMPLETED');
        const same = previous?.find(row => row.id === id || !round&&row.recordId === record.id && decisionSignature(row.record) === decisionSignature(record));
        if (same) {requireValue(!same.placement || same.placement === placement, 'DECISION_EXECUTION_PLACEMENT_CONFLICT'); return previous!;}
        requireValue(round||!previous?.some(row => row.recordId === record.id && !['completed','failed','cancelled'].includes(row.state)), 'DECISION_EXECUTION_UNSETTLED');
        requireValue((previous?.length ?? 0) < 100, 'RECORD_EXECUTION_LIMIT');
        const candidate=newRun(board,record,request,id);
        if(control?.after==='restart')candidate.previousRunId=previous?.filter(row=>row.recordId===record.id).sort((a,b)=>b.createdAt-a.createdAt)[0]?.id;
        return [...previous??[],candidate];
    });
    await options.journal.update('record-context:'+id,old=>old??{sourceBoardId:boardId,recordId:record.id,recordRevision:record.revision,runId:id,previousRunId:saved.find(run=>run.id===id)?.previousRunId});
    const original = saved.find(row => row.id === id || !round&&row.recordId === record.id && decisionSignature(row.record) === decisionSignature(record))!;
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
            const unstarted=run.record.dependsOn?.length&&!await options.journal.get('record-dependency-admission:'+run.id);
            const state = await advanceRecordControl(options.service, options.journal, unstarted?{...run,boardId:run.sourceBoardId,itemIds:[],rootItemId:undefined}:run, control);
            const updated = await save(options, {...run, state, updatedAt: Date.now()});
            if (state !== run.state) options.log({operationId:control.operationId, boardId:run.sourceBoardId, stage:'record.control.' + control.action, result:state==='unknown'||state==='blocked'?'failure':'success', code:updated.code, durationMs:Date.now()-started});
            if (control.action === 'resume' && state === 'running') {
                const runs = await options.journal.activeRecordRuns<SavedRun>(run.sourceBoardId,run.recordId);
                if (runs.every(row => row.state==='running')) await options.journal.update<RecordControl>(recordControlKey(run.sourceBoardId, run.recordId), old => ({...old!, settled: true}));
            }
            if (state === 'cancelled') {
                const runs = await options.journal.activeRecordRuns<SavedRun>(run.sourceBoardId,run.recordId);
                if (!runs.length) await finishDecisionCancellation(options, run.sourceBoardId, run.recordId, control.operationId);
            }
            return view(updated);
        }
        await validateResourceReferences(options.resources, run.record);
        if(!await admitDependencies(options,run,started)){const current=await options.journal.run<SavedRun>(run.sourceBoardId,run.id);requireValue(current,'RECORD_EXECUTION_CHECKPOINT_MISSING');return view(current);}
        await materialize(options, run);
        const board = await options.service.read(run.boardId);
        const items = run.itemIds ? await Promise.all(run.itemIds.map(async id => board.items.find(item => item.id === id) ?? (await options.service.item(run.boardId, id)).item)) : board.items;
        if(run.rootItemId&&!run.itemIds?.includes(run.rootItemId)&&items.every(item=>item.purpose!=='planning')&&board.items.find(item=>item.id===run.rootItemId)?.purpose==='planning')await once(options,run,'finish-planning',{type:'finish-planning',itemId:run.rootItemId});
        const stage=items.some(item=>item.purpose==='planning')?'planning' as const:'execution' as const;
        const state=runState(items);
        if (state === 'completed' && run.rootItemId && !run.itemIds?.includes(run.rootItemId) && board.items.find(item => item.id === run.rootItemId)?.status !== 'completed') {
            await once(options, run, 'close-root'+(board.items.find(item=>item.id===run.rootItemId)?.executionEpoch??''), {type: 'close-plan', itemId: run.rootItemId, resultRef: 'kanban-run:' + run.id});
        }
        const completion=state==='completed'?runCompletion(items,board.items):undefined;
        const code = state === 'failed' ? 'DECISION_TASK_CANCELLED' : state === 'blocked' ? blockedCode(items) : undefined;
        if (run.state===state&&run.code===code&&run.stage===stage&&run.completion===completion) return view(run);
        const updated = await save(options, {...run,state,code,stage,completion,updatedAt: Date.now()});
        options.log({operationId: run.id, boardId: run.sourceBoardId, stage: 'record.run', result: ['failed','blocked','unknown'].includes(state) ? 'failure' : 'success', code: updated.code, durationMs: Date.now() - started});
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
    return sha256HexSync(JSON.stringify([record.title, record.content, record.rationale, record.externalRefs,record.completion,record.verificationLevel,record.deliveryMode,record.executionEpoch,record.priority,record.dependsOn]));
}
function newRun(board: KanbanBoard, record: KanbanProjectRecord, request: KanbanRecordRunRequest, id: string): SavedRun {
    const placement = request.placement ?? 'current-board';
    requireValue(['current-board', 'new-board'].includes(placement), 'INVALID_EXECUTION_PLACEMENT');
    requireValue(placement === 'new-board' || board.automation?.enabled, 'AUTOMATION_PAUSED');
    const types = board.workTypes ?? DEFAULT_KANBAN_WORK_TYPES;
    const task = types.find(type => type.id === (board.defaultWorkType ?? 'task') && type.executable) ?? types.find(type => type.executable);
    const parent = types.find(type=>type.id==='coordination'&&!type.executable)??types.find(type => !type.executable);
    requireValue(task&&parent,'DECISION_WORK_TYPES_REQUIRED');
    const itemIds = ['work-' + id + '-0'];
    return {id, sourceBoardId: board.id, recordId: record.id, recordRevision: record.revision,
        boardId: placement === 'new-board' ? 'run-' + id : board.id, placement, taskKind: parent.id, parentKind: parent.id,
        rootItemId:itemIds[0],itemIds,sharedCoordination:true,
        state:'preparing',stage:'planning',createdAt: Date.now(), updatedAt: Date.now(), record, settings:structuredClone(board.settings), automation: structuredClone(board.automation!)};
}
function runCompletion(items:KanbanItem[],all:KanbanItem[]):KanbanRecordExecution['completion'] {
    const outcomes=items.map(item=>projectKanbanTask(item,undefined,Date.now(),all).completion);
    if(outcomes.includes('mixed'))return 'mixed';
    if(outcomes.includes('waived'))return 'waived';
    return 'children';
}
function runState(items: KanbanItem[]): KanbanRecordExecution['state'] {
    if (items.some(item => item.status === 'cancelled')) return 'failed';
    if (items.length && items.every(item => item.status === 'completed')) return 'completed';
    if (items.some(item => item.blocked || ['waiting-input','error','unknown'].includes(projectKanbanTask(item).phase))) return 'blocked';
    return items.length && items.every(item => ['completed', 'review'].includes(item.status)) ? 'review' : 'running';
}
function blockedCode(items:KanbanItem[]):string|undefined {
    const tasks=items.map(item=>projectKanbanTask(item));
    if(tasks.some(task=>task.phase==='waiting-input'))return 'DECISION_INPUT_REQUIRED';
    const failed=tasks.find(task=>task.phase==='error'||task.phase==='unknown');
    return failed?failed.reason&&/^[A-Z][A-Z0-9_]{0,79}$/.test(failed.reason)?failed.reason:'DECISION_PLANNING_FAILED':undefined;
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
        planning: {kind: run.parentKind!, priority: run.record.priority ?? 2, dependencies: [], references: []}});
    const scopes=run.sharedCoordination?[run.record.externalRefs??refs]:refs.map(reference=>[reference]);
    for (const [index, references] of scopes.entries()) {
        await once(options, run, 'item-' + index, {type: 'create-item', item: {id: run.itemIds?.[index] ?? 'work-' + index,
            title: run.record.title, responsibility: run.record.content, acceptance: run.record.rationale ?? run.record.content,purpose:'planning',
            externalRefs: [...references, {system: options.resources.decisionSystem ?? 'kanban-decision', id: run.id}]},
            ...(run.taskKind ? {planning: {kind: run.taskKind, priority: run.record.priority ?? 2, dependencies: [], references: [], ...(group ? {parentId: run.rootItemId} : {})}} : {})});
    }
    await markPlanning(options,run);
    if(run.boardId!==run.sourceBoardId && run.settings)await once(options,run,'settings',{type:'configure-board-settings',settings:run.settings});
    if (run.boardId !== run.sourceBoardId) await once(options, run, 'automation', {type: 'configure-automation', settings: {...run.automation, enabled: true, autoAccept: false}});
    if(run.boardId===run.sourceBoardId&&!run.recurring)for(const itemId of run.rootItemId?[run.rootItemId]:run.itemIds??[])await once(options,run,'link-'+itemId,{type:'link-record',recordId:run.recordId,itemId});
}

async function once(options: Options, run: SavedRun, stage: string, command: KanbanCommand): Promise<void> {
    const key = 'record-stage:' + run.id + ':' + stage;
    await journalCommand(options.journal, options.service, run.boardId, key, command);
}
async function save(options: Options, run: SavedRun): Promise<SavedRun> {
    return options.journal.saveRun(run.sourceBoardId,run);
}

async function attachManagementTasks(options:Options,runs:KanbanRecordExecution[],includeArchived=false):Promise<void> {
    const scopes=new Map<string,KanbanRecordExecution[]>();
    for(const run of runs){
        if((!includeArchived&&run.archivedAt!==undefined)||(!run.rootItemId&&!run.itemIds?.length))continue;
        const rows=scopes.get(run.boardId)??[];
        rows.push(run);scopes.set(run.boardId,rows);
    }
    await forEachRecordScope(scopes,([boardId,rows])=>readManagementTasks(options,boardId,rows));
}

async function readManagementTasks(options:Options,boardId:string,runs:KanbanRecordExecution[]):Promise<void> {
    const idsFor=(run:KanbanRecordExecution)=>run.rootItemId?[run.rootItemId]:run.itemIds??[];
    const ids=[...new Set(runs.flatMap(idsFor))];
    const tasks=new Map<string,NonNullable<KanbanRecordExecution['managementTasks']>[number]>();
    for(let offset=0;offset<ids.length;offset+=200){
        const batch=ids.slice(offset,offset+200),started=Date.now();
        try{
            const page=await options.service.query(boardId,{ids:batch,view:'all',limit:200});
            await Promise.all(page.items.map(async item=>{
                const {id,title,task}=item;
                const projected=task?.reason==='GROUP_SETTLEMENT_PENDING'&&options.projectManagementTask ? await options.projectManagementTask(boardId,id,task) : task;
                const reference = page.boardNumber && isRecurringTask(item) ? kanbanReference({id:boardId,number:page.boardNumber},item) : undefined;
                tasks.set(id,{id,title,reference,task:projected});
            }));
            options.log({operationId:runs[0].id,boardId,stage:'record.management-tasks.read',result:'success',durationMs:Date.now()-started});
        }catch(error){
            const code=safeCode(error,'OPERATION_UNAVAILABLE');
            for(const id of batch)tasks.set(id,{id,code});
            options.log({operationId:runs[0].id,boardId,stage:'record.management-tasks.read',result:'failure',code,durationMs:Date.now()-started});
        }
    }
    for(const run of runs)run.managementTasks=idsFor(run).map(id=>tasks.get(id)??{id,code:'TASK_GROUP_UNAVAILABLE'});
}

function view(run: KanbanRecordExecution): KanbanRecordExecution {
    const {id, recordId, recordRevision, boardId, rootItemId, itemIds, state, createdAt, updatedAt,archivedAt,stage,code,completion,dependencies,scheduledAt,recurrenceRevision} = run;
    const waiting=code?.startsWith('DECISION_DEPENDENCY_');
    return {id, recordId, recordRevision, boardId, ...(dependencies?{dependencies}:{}), ...(!waiting&&rootItemId?{rootItemId}:{}),...(!waiting&&itemIds?{itemIds}:{}), state,createdAt,updatedAt,...(scheduledAt!==undefined?{scheduledAt}:{}),...(recurrenceRevision!==undefined?{recurrenceRevision}:{}),...(completion?{completion}:{}),...(stage?{stage}:{}),...(archivedAt!==undefined?{archivedAt}:{}), ...(code ? {code} : {})};
}

async function cancelDecision(options: Options, boardId: string, recordId: string, operationId: string): Promise<void> {
    const record = await options.service.record(boardId, recordId);
    if (record.status !== 'cancelled') await journalCommand(options.journal, options.service, boardId, 'record-cancel:' + JSON.stringify([boardId,recordId,operationId]), {type: 'cancel-record', recordId});

}

async function finishDecisionCancellation(options: Options, boardId: string, recordId: string, operationId: string): Promise<void> {
    const started=Date.now(),control=await options.journal.get<RecordControl>(recordControlKey(boardId,recordId));
    requireValue(control,'RECORD_CONTROL_ACTIVE');if(control.settled)return;
    const runs=(await options.journal.activeRecordRuns<SavedRun>(boardId,recordId)).filter(run=>!(control.after==='restart'&&run.record.executionEpoch===control.operationId));
    if(runs.some(run=>!['completed','failed','cancelled'].includes(run.state)))return;
    const record=await options.service.record(boardId,recordId);
    if(record.executionEpoch!==control.operationId){
        const state=await advanceRecordControl(options.service,options.journal,{id:operationId,sourceBoardId:boardId,boardId,recordId,recordRevision:record.revision,itemIds:record.itemIds,state:'cancelling',createdAt:0,updatedAt:0},control);
        if(state!=='cancelled')return;
        await cancelDecision(options,boardId,recordId,operationId);
    }
    if(control.after)await disposeRunHistory(options,boardId,recordId,control,operationId);
    if(control.after==='restart')await restartDecision(options,boardId,recordId,operationId);
    else if(control.after)await journalCommand(options.journal,options.service,boardId,'record-dispose:'+operationId,{type:control.after==='delete'?'delete-record':'archive-record',recordId});
    await options.journal.update<RecordControl>(recordControlKey(boardId,recordId),old=>({...old!,settled:true}));
    options.log({operationId,boardId,stage:'record.control.'+(control.after??'cancel')+'.settled',result:'success',durationMs:Date.now()-started});
}
async function disposeRunHistory(options:Options,boardId:string,recordId:string,control:RecordControl,operationId:string):Promise<void> {
    let cursor:string|undefined;
    do {
        const page=await options.journal.runHistoryPage(boardId,recordId,50,cursor);
        for(const summary of page.items){
            if(control.after==='restart'&&summary.record?.executionEpoch===operationId)continue;
            if(control.after!=='delete'&&summary.archivedAt!==undefined)continue;
            const run=await options.journal.run<SavedRun>(boardId,summary.id);requireValue(run,'RECORD_EXECUTION_CHECKPOINT_MISSING');
            await cleanupRecordTasks(options.service,options.journal,[run],control.after==='delete'?'delete':'archive',operationId,options.archiveSession,options.planningSession,options.archiveItemResources);
            if(run.archivedAt===undefined)await options.journal.saveRun(boardId,{...run,archivedAt:Date.now()});
        }
        cursor=page.nextCursor;
    }while(cursor);
}
async function restartDecision(options:Options,boardId:string,recordId:string,operationId:string):Promise<void> {
    await journalCommand(options.journal,options.service,boardId,'record-restart:'+operationId,{type:'restart-record',recordId,epoch:operationId});
    const record=await options.service.record(boardId,recordId);
    let cursor:string|undefined,existing:SavedRun|undefined;
    do {const page=await options.journal.runHistoryPage(boardId,recordId,50,cursor);const found=page.items.find(run=>run.record?.executionEpoch===operationId);
        if(found)existing=await options.journal.run<SavedRun>(boardId,found.id);cursor=page.nextCursor;
    }while(cursor&&!existing);
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

async function admitDependencies(options:Options,run:SavedRun,started:number):Promise<boolean> {
    if(!run.record.dependsOn?.length)return true;
    const key='record-dependency-admission:'+run.id;if(await options.journal.get(key))return true;
    const refs=await validateDecisionDependencies(options.service,run.sourceBoardId,run.recordId,run.record.dependsOn);
    const dependencies=await decisionDependencyStates(refs,options.dependencyRecords??(async board=>(await withRecordProgress(await options.service.records(board,{kind:'decision',includeArchived:true,limit:200}),board,options.journal,options.service)).items));
    if(dependencies.some(row=>row.state!=='completed')){
        const code=dependencies.some(row=>row.state==='unavailable')?'DECISION_DEPENDENCY_UNAVAILABLE':'DECISION_DEPENDENCY_WAITING';
        if(run.code!==code||JSON.stringify(run.dependencies)!==JSON.stringify(dependencies)){
            await save(options,{...run,state:'blocked',code,dependencies,updatedAt:Date.now()});
            options.log({operationId:run.id,boardId:run.sourceBoardId,stage:'record.dependencies.wait',result:'success',code,durationMs:Date.now()-started});
        }
        return false;
    }
    await options.journal.update(key,old=>old??{dependencies,admittedAt:Date.now()});
    options.log({operationId:run.id,boardId:run.sourceBoardId,stage:'record.dependencies.admit',result:'success',durationMs:Date.now()-started});return true;
}
