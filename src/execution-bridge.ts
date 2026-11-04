import {boardAllowsStart} from './contracts/board-control';
import {taskDue} from './contracts/task-projection';
import {sha256HexSync, randomUUID} from './utils';
import type {IFileSystem} from '@nestos/vfs-core';
import type {KanbanDispatch, KanbanService, KanbanItem, KanbanArtifactRef, KanbanPrincipal, KanbanEstimate} from './contracts';
import {KanbanError} from './ports';
import {executionObservationChanged} from './execution-observation';

export interface KanbanExecutionObservation {
    controlCapabilities?: {pause:'boundary'|'none';resume:boolean};
    executionSessionId?: string;
    outcome: 'running' | 'unknown' | 'succeeded' | 'failed' | 'cancelled';
    outputs?: KanbanArtifactRef[]; code?: string;
}
export interface KanbanExecutionPort {
    prepareContinuation?(dispatch: KanbanDispatch, item: KanbanItem, previousRequest: unknown): Promise<unknown>;
    /** Persistable request; preparing cannot submit agent work. */
    prepare(dispatch: KanbanDispatch, item: KanbanItem): Promise<unknown>;
    start(request: unknown): Promise<KanbanExecutionObservation>;
    /** Observe the original admission only. Missing receipts mean unknown. */
    inspect(request: unknown): Promise<KanbanExecutionObservation>;
}
export interface KanbanExecutionBridgeOptions {
    fs: IFileSystem; directory: string; boardId: string; service: KanbanService;
    worker(principal: KanbanPrincipal): Promise<KanbanService>;
    executor: KanbanExecutionPort;
    authorize(stage: 'prepare' | 'start' | 'inspect', dispatch: KanbanDispatch): Promise<void>;
    log(input: {operationId: string; stage: string; result: 'success' | 'failure'; code?: string; retryAfterMs?: number; durationMs: number}): void;
    executionReference?(sessionId: string, dispatchId: string): import('./contracts').KanbanExternalReference;
    subscribe?(wake: () => void): () => void;
    now?:()=>number;
    autoDispatch?: boolean | (() => Promise<boolean>); shutdownTimeoutMs?: number;
    estimate?(item: KanbanItem, principal: KanbanPrincipal): Promise<KanbanEstimate | undefined>;
}
interface ExecutionRecord {schema: 1; fence: string; request: unknown; digest: string; phase: 'prepared' | 'submitting'}
interface ReadFailure {code: string; count: number; retryAt: number}
type TrackWrite = <T>(operation: Promise<T>) => Promise<T>;

/** The host owns execution. Prepared/submitting identities survive response loss and host shutdown. */
export async function createKanbanExecutionBridge(options: KanbanExecutionBridgeOptions) {
    const path = `${options.directory}/executions.seq`;
    try {await options.fs.driver.createFile({parentPath:options.directory,name:'executions.seq',type:'seqfile',recursive:true});}
    catch(error) {if((error as {code?:string})?.code!=='EEXIST') throw error;}
    if(!options.fs.meta.seq?.transaction) throw new KanbanError('TRANSACTION_REQUIRED');
    let stopped=false, again=false, pending: Promise<void>|undefined;
    const writes=new Set<Promise<unknown>>();
    const failures = new Map<string, ReadFailure>();
    const track:TrackWrite=operation=>{const tracked=operation.finally(()=>{writes.delete(tracked);});writes.add(tracked);return tracked;};
    const active=()=>!stopped;
    const scan=async()=>{if(stopped) return; if(pending) {again=true; return pending;} const started=Date.now();
        pending=runBridge(options,path,active,track,failures).catch(error=>{try {options.log({operationId:randomUUID(),stage:'bridge.scan',result:'failure',code:safeCode(error),durationMs:Date.now()-started});} catch {/* Diagnostics cannot replay work. */} throw error;}).finally(()=>{pending=undefined;if(again&&!stopped) {again=false;void scan().catch(()=>{});}});
        return pending;
    };
    const unsubscribe=options.subscribe?.(()=>{void scan().catch(()=>{});});
    return {scan, tick: scan, async quiesce() {
        stopped=true;unsubscribe?.(); if(!pending) return;
        let timer: ReturnType<typeof setTimeout>|undefined;
        try {await Promise.race([pending,new Promise<void>(resolve=>{timer=setTimeout(resolve,options.shutdownTimeoutMs ?? 5000);})]);}
        finally {if(timer) clearTimeout(timer);await Promise.allSettled([...writes]);}
    }};
}
async function runBridge(options: KanbanExecutionBridgeOptions, path: string, active: () => boolean, track: TrackWrite, failures: Map<string, ReadFailure>): Promise<void> {
    const workflow=await options.service.workflow(options.boardId);
    const live = new Set(Object.values(workflow.dispatches).filter(dispatch => ['prepared', 'running', 'unknown'].includes(dispatch.outcome)).map(dispatch => dispatch.id));
    for (const id of failures.keys()) if (!live.has(id)) failures.delete(id);
    for(const dispatch of Object.values(workflow.dispatches)) {
        if(!active()) return;
        if(live.has(dispatch.id) && (failures.get(dispatch.id)?.retryAt ?? 0) <= Date.now()) await runDispatch(options,path,dispatch,active,track,failures);
    }
    const automatic = typeof options.autoDispatch === 'function' ? await options.autoDispatch() : options.autoDispatch;
    if(!automatic||!active()) return;
    for(const id of (await options.service.workflow(options.boardId)).ready) {
        if(!active()) return;
        const {item}=await options.service.item(options.boardId,id), owner=item.eligiblePrincipals?.[0]; if(!owner || !taskDue(item, (options.now??Date.now)())) continue;
        const worker=await options.worker(owner), board=await worker.read(options.boardId);if(!active()) return;
        if (!boardAllowsStart(board, item)) continue;
        try {
            const dispatchId=randomUUID();
            const estimate=await options.estimate?.(item,owner);if(!active()) return;
            await worker.execute(board.id,{operationId:'dispatch:'+dispatchId,expectedRevision:board.revision,command:{type:'prepare-dispatch',itemId:id,dispatchId,estimate,trigger:'automatic'}});
            const dispatch=(await options.service.workflow(board.id)).dispatches[dispatchId];
            if(active()) await runDispatch(options,path,dispatch,active,track,failures);
        }
        catch(error) {if(!['WIP_LIMIT','ASSIGNEE_WIP_LIMIT','READY_LIMIT','REVISION_CONFLICT'].includes(safeCode(error))) throw error;}
    }
}
async function runDispatch(options: KanbanExecutionBridgeOptions, path: string, dispatch: KanbanDispatch, active: () => boolean, track: TrackWrite, failures: Map<string, ReadFailure>): Promise<void> {
    const start=Date.now(); let stage: 'inspect' | 'prepare' | 'start'='inspect', result: KanbanExecutionObservation;
    const previousFailure = failures.has(dispatch.id);
    try {
        let record=await loadRecord(options,path,dispatch);if(!active()) return;
        if ((!record || record.phase === 'prepared') && (await options.service.read(options.boardId)).executionControl?.paused) return;
        if(!record) {
            stage='prepare';await options.authorize(stage,dispatch);if(!active()) return;
            const item=(await options.service.item(options.boardId,dispatch.itemId)).item;if(!active()) return;
            const request=await prepareRequest(options, path, dispatch, item);if(!active()) return;
            record=await track(savePrepared(options,path,dispatch,request));
        }
        if(!active()) return;
        const submit=record.phase==='prepared'&&await track(claimSubmission(options,path,dispatch));
        if(!active()) return; stage=submit?'start':'inspect';await options.authorize(stage,dispatch);if(!active()) return;
        result=await (submit?options.executor.start(record.request):options.executor.inspect(record.request));
        failures.delete(dispatch.id);
    } catch(error) {
        const notStarted = (error as {executionOutcome?: string; retryable?: boolean})?.executionOutcome === 'not-started'
            && (error as {retryable?: boolean}).retryable === true;
        if (notStarted && stage === 'start') await track(releaseUnstartedSubmission(options, path, dispatch));
        result={outcome:stage==='prepare'&&!notStarted?'failed':'unknown',code:safeCode(error)};
        if (stage === 'inspect' || notStarted) {
            const previous = failures.get(dispatch.id), count = previous && previous.code === result.code ? previous.count + 1 : 1;
            failures.set(dispatch.id, {code: result.code!, count, retryAt: Date.now() + Math.min(60000, 1000 * 2 ** Math.min(count - 1, 6))});
        }
    }
    if (stage !== 'inspect' || executionObservationChanged(dispatch, result) || previousFailure && !failures.has(dispatch.id))
        try {options.log({operationId:dispatch.id,stage:`bridge.${stage}`,result:['unknown','failed','cancelled'].includes(result.outcome)?'failure':'success',code:result.code,...(failures.has(dispatch.id)?{retryAfterMs:Math.max(0,failures.get(dispatch.id)!.retryAt-Date.now())}:{}),durationMs:Date.now()-start});} catch {/* Metadata-only diagnostics. */}
    if(active()) try {await linkSession(options,dispatch,result.executionSessionId);if(active()) await settle(options,dispatch,result);} catch(error) {if(safeCode(error)!=='REVISION_CONFLICT') throw error;}
}
async function releaseUnstartedSubmission(options: KanbanExecutionBridgeOptions, path: string, dispatch: KanbanDispatch): Promise<void> {
    await options.fs.meta.seq!.transaction!(async tx => {
        const raw = await tx.getEntry(path, dispatch.id);
        if (!raw) throw new KanbanError('EXECUTION_JOURNAL_MISSING');
        const record = decodeRecord(raw, dispatch);
        if (record.phase === 'submitting') await tx.setEntry(path, dispatch.id, JSON.stringify({...record, phase: 'prepared'}));
    });
}
async function prepareRequest(options: KanbanExecutionBridgeOptions, path: string, dispatch: KanbanDispatch, item: KanbanItem): Promise<unknown> {
    if (!dispatch.continuation) return options.executor.prepare(dispatch, item);
    if (!options.executor.prepareContinuation) throw new KanbanError('CONTINUATION_UNSUPPORTED');
    const previous = (await options.service.workflow(options.boardId)).dispatches[dispatch.continuation.previousDispatchId];
    if (!previous || previous.itemId !== dispatch.itemId) throw new KanbanError('CONTINUATION_SCOPE_MISMATCH');
    const record = await loadRecord(options, path, previous);
    if (!record) throw new KanbanError('EXECUTION_JOURNAL_MISSING');
    return options.executor.prepareContinuation(dispatch, item, record.request);
}
async function loadRecord(options: KanbanExecutionBridgeOptions, path: string, dispatch: KanbanDispatch): Promise<ExecutionRecord|undefined> {
    const raw=await options.fs.meta.seq!.getEntry(path,dispatch.id); if(!raw) return;
    return decodeRecord(raw,dispatch);
}
async function savePrepared(options: KanbanExecutionBridgeOptions, path: string, dispatch: KanbanDispatch, request: unknown): Promise<ExecutionRecord> {
    const rawRequest=JSON.stringify(request);
    if(typeof rawRequest!=='string'||new TextEncoder().encode(rawRequest).byteLength>1024*1024) throw new KanbanError('INVALID_EXECUTION_REQUEST');
    return options.fs.meta.seq!.transaction!(async tx=>{
        const raw=await tx.getEntry(path,dispatch.id);if(raw) return decodeRecord(raw,dispatch);
        const record: ExecutionRecord={schema:1,fence:dispatch.fence,request:JSON.parse(rawRequest),digest:sha256HexSync(rawRequest),phase:'prepared'};
        await tx.setEntry(path,dispatch.id,JSON.stringify(record));return record;
    });
}
async function claimSubmission(options: KanbanExecutionBridgeOptions, path: string, dispatch: KanbanDispatch): Promise<boolean> {
    return options.fs.meta.seq!.transaction!(async tx=>{
        const raw=await tx.getEntry(path,dispatch.id);if(!raw) throw new KanbanError('EXECUTION_JOURNAL_MISSING');
        const record=decodeRecord(raw,dispatch);
        if(record.phase!=='prepared') return false;
        await tx.setEntry(path,dispatch.id,JSON.stringify({...record,phase:'submitting'}));return true;
    });
}
function decodeRecord(raw: string, dispatch: KanbanDispatch): ExecutionRecord {
    const record=JSON.parse(raw) as ExecutionRecord;
    if(record.schema!==1||record.fence!==dispatch.fence||!['prepared','submitting'].includes(record.phase)||record.digest!==sha256HexSync(JSON.stringify(record.request))) throw new KanbanError('INVALID_EXECUTION_JOURNAL');return record;
}
async function settle(options: KanbanExecutionBridgeOptions, dispatch: KanbanDispatch, result: KanbanExecutionObservation): Promise<void> {
    const current=(await options.service.workflow(options.boardId)).dispatches[dispatch.id];
    if(!current||!['prepared','running','unknown'].includes(current.outcome)) return;
    const board=await options.service.read(options.boardId), item=board.items.find(item=>item.id===dispatch.itemId);
    const renew=['running','unknown'].includes(result.outcome) && (item?.owner?.leaseUntil ?? 0) <= Date.now() + board.policy.leaseMs / 2;
    if(!renew&&!executionObservationChanged(current,result)) return;
    const {outcome,outputs,code,executionSessionId,controlCapabilities}=result, observation={outcome,...(controlCapabilities?{controlCapabilities}:{}),...(executionSessionId?{executionSessionId}:{}),...(outputs?{outputs}:{}),...(code?{code}:{})};
    const digest=sha256HexSync(JSON.stringify(observation));
    await options.service.execute(board.id,{operationId:`settle:${dispatch.id}:${digest}:${board.revision}`,expectedRevision:board.revision,
        command:{type:'observe-execution',dispatchId:dispatch.id,fence:dispatch.fence,...observation}});
}
async function linkSession(options: KanbanExecutionBridgeOptions, dispatch: KanbanDispatch, sessionId?: string): Promise<void> {
    if(!sessionId || !options.executionReference) return;
    const reference = options.executionReference(sessionId, dispatch.id);
    const board=await options.service.read(options.boardId),item=board.items.find(item=>item.id===dispatch.itemId);
    if(item?.owner?.token!==dispatch.fence) throw new KanbanError('STALE_EXECUTION_RESULT');
    const current=item.externalRefs?.filter(ref=>ref.system===reference.system).at(-1);
    if(current?.id===reference.id&&current.revision===reference.revision) return;
    await options.service.execute(board.id,{operationId:`execution-session:${dispatch.id}:${sha256HexSync(sessionId)}:${board.revision}`,expectedRevision:board.revision,
        command:{type:'link-reference',itemId:dispatch.itemId,reference}});
}
function safeCode(error: unknown): string {
    const code=(error as {reasonCode?:unknown})?.reasonCode??(error as {code?:unknown})?.code;return typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:'EXECUTION_OBSERVATION_FAILED';
}
