import {kanbanTaskType} from '../contracts';
import {sha256HexSync, randomUUID} from '../utils';
import type {KanbanAnalysisStatus,KanbanBoard,KanbanItem,KanbanService,KanbanEstimate,KanbanExternalReference} from '../contracts';
import {requireValue} from '../rules';
import {adoptDecomposition,validateSubtasks,type AnalysisSubtask} from './analysis-decomposition';
import type {KanbanAutomationJournal} from './automation-journal';
import type {AnalysisJournalEntry} from './analysis-history';
import {safeCode} from './diagnostics';
export interface AnalysisResult {ready:boolean;dependencies:string[];reason:string;estimate?:KanbanEstimate;subtasks?:AnalysisSubtask[]}
export interface KanbanAnalysisObservation {state:'running'|'unknown'|'clarification'|'succeeded'|'failed'|'cancelled';output?:unknown;code?:string;reason?:string}
export interface KanbanAnalysisPort<Target = KanbanExternalReference, Input = unknown> {
    prepare(input:{id:string;board:KanbanBoard;item:KanbanItem;target:Target}):Promise<Input>;
    prepareExecution(id:string,input:Input):Promise<void>;
    submit(input:Input):Promise<void>;
    inspect(id:string,input:Input):Promise<KanbanAnalysisObservation>;
}
interface AnalysisJob<Input> extends AnalysisJournalEntry {input:Input;result?:AnalysisResult;signatureVersion?:2}
export interface KanbanAnalysisOptions<Target = KanbanExternalReference, Input = unknown> {
    journal:KanbanAutomationJournal;port:KanbanAnalysisPort<Target,Input>;active():boolean;
    retryable?(error:unknown):boolean;
    inheritReferences?(references:readonly KanbanExternalReference[]):KanbanExternalReference[];
    onSettled?(input:{boardId:string;id:string;item:KanbanItem;request:Input;outcome:'succeeded'|'failed'|'cancelled';code?:string}):Promise<void>;
    log(input:{operationId:string;stage:string;result:'success'|'failure';code?:string;durationMs:number}):void;
}
const keyFor = (board: string, item: string) => 'analysis-current:' + JSON.stringify([board, item]);
export async function analysisStatus<Input = unknown>(journal: KanbanAutomationJournal, board: string, item: string): Promise<KanbanAnalysisStatus | null> {
    const key = await journal.get<string>(keyFor(board, item));
    return key ? (await journal.get<AnalysisJob<Input>>(key))?.status ?? null : await journal.get<KanbanAnalysisStatus>('decomposition-status:'+JSON.stringify([board,item]))??null;
}
export function analysisSignature(board: KanbanBoard,itemId?:string): string {
    return sha256HexSync(JSON.stringify([board.automation, board.items.filter(item=>!itemId||item.id===itemId).map(item => itemId?[item.id,item.title,item.responsibility,item.acceptance,item.planning,item.externalRefs]:[item.id,item.title,item.responsibility,item.acceptance,item.planning])]));
}
export async function analyzeItem<Target, Input>(options: KanbanAnalysisOptions<Target, Input>, board: KanbanBoard, item: KanbanItem, target: Target | undefined, service: KanbanService): Promise<void> {
    const started = Date.now();
    if (!options.active()) return;
    const loaded = await loadJob(options, board, item, target);
    if (!loaded || !options.active()) return;
    const {key} = loaded; let {job} = loaded;
    if (job.phase === 'prepared') job = await submitAnalysis(options, key, job);
    if (!options.active()) return;
    if (job.phase === 'submitting' || job.phase === 'waiting-input' || job.status.state==='clarification') job = await observeAnalysis(options, key, job);
    job = await finalizeAnalysis(options, board.id, item, key, job);
    if (job.result?.ready && job.status.state === 'ready' && !board.executionControl?.paused && board.automation?.enabled && options.active()) {
        try {await adoptAnalysis(options.journal, board, item, job, service, options.inheritReferences?.(item.externalRefs ?? []) ?? []);}
        catch (error) {await saveFailure(options, key, job, safeCode(error, 'AUTOMATION_PLAN_REJECTED'));}
    }
    if (!options.active()) return;
    const status = (await options.journal.get<AnalysisJob<Input>>(key))?.status;
    let changed=false;
    if (status) {
        const currentBoard = await service.read(board.id), currentItem = currentBoard.items.find(i => i.id === item.id)!;
        if (currentItem.control?.action === 'cancel' || ['completed','cancelled'].includes(currentItem.status)) return;
        if (JSON.stringify(currentItem.analysis) !== JSON.stringify(status)) {changed=true;await service.execute(board.id, {operationId:'analysis-status:'+job.id+':'+currentBoard.revision+':'+sha256HexSync(JSON.stringify(status)), expectedRevision:currentBoard.revision, command:{type:'report-analysis',itemId:item.id,operationId:job.id,status}});}
    }
    if(changed)options.log({operationId: job.id, stage: 'automation.analysis', result: status?.state === 'failed' || status?.state === 'unknown' ? 'failure' : 'success', code: status?.code, durationMs: Date.now() - started});
}
async function finalizeAnalysis<Target, Input>(options: KanbanAnalysisOptions<Target, Input>, boardId: string, item: KanbanItem, key: string, job: AnalysisJob<Input>): Promise<AnalysisJob<Input>> {
    if (!options.active() || job.phase !== 'settled' || !options.onSettled) return job;
    try {
        await options.onSettled({boardId, id: job.id, item, request: job.input,
            outcome: job.terminalOutcome ?? (job.status.state === 'failed' ? 'failed' : 'succeeded'), code: job.status.code});
        return job;
    } catch (error) {if(options.retryable?.(error))throw error;return options.active() ? saveFailure(options, key, job, safeCode(error, 'AUTOMATION_ANALYSIS_FINALIZATION_FAILED')) : job;}
}
async function loadJob<Target, Input>(options: KanbanAnalysisOptions<Target, Input>, board: KanbanBoard, item: KanbanItem, target?: Target) {
    requireValue(board.items.length <= 200, 'AUTOMATION_CONTEXT_LIMIT');
    const signature = analysisSignature(board,item.id), currentKey = await options.journal.get<string>(keyFor(board.id, item.id));
    const currentJob = currentKey ? await options.journal.get<AnalysisJob<Input>>(currentKey) : undefined;
    if (!board.automation?.enabled && !['submitting','waiting-input'].includes(currentJob?.phase??'')) return;
    const key = currentJob && (['submitting','waiting-input'].includes(currentJob.phase)||currentJob.status.state==='clarification') ? currentKey! : 'analysis:' + sha256HexSync(JSON.stringify([board.id, item.id, item.launch?.requestedAt, item.launch?.analysisEpoch, signature]));
    let job = await options.journal.get<AnalysisJob<Input>>(key);
    if (!job) {
        requireValue(target, 'AUTOMATION_TARGET_CHANGED');
        const id = await options.journal.update<string>('analysis-identity:' + key, old => old ?? randomUUID());
        const input = await options.port.prepare({id, board, item, target});
        const candidate: AnalysisJob<Input> = {id,signature,signatureVersion:2,itemRevision:item.revision,phase:'prepared',status:{itemId:item.id,state:'analyzing'},input};
        job = await options.journal.update<AnalysisJob<Input>>(key, previous => previous ?? candidate);
    }
    if (!options.active()) return;
    if (currentKey !== key) await options.journal.update<{keys: string[]; indexed?: boolean}>('analysis-history:' + JSON.stringify([board.id, item.id]), old =>
        ({...old, keys: [...new Set([...old?.keys ?? [], ...currentKey ? [currentKey] : [], key])]}));
    await options.journal.update(keyFor(board.id, item.id), () => key);
    if (!options.active()) return;
    return {key, job};
}

async function submitAnalysis<Target,Input>(options:KanbanAnalysisOptions<Target,Input>,key:string,job:AnalysisJob<Input>):Promise<AnalysisJob<Input>> {
    try {await options.port.prepareExecution(job.id,job.input);}
    catch(error){if(options.retryable?.(error))throw error;return options.active()?saveFailure(options,key,job,safeCode(error,'AUTOMATION_ANALYSIS_PREPARE_FAILED')):job;}
    if(!options.active())return job;
    const claimed=await options.journal.claim(key),latest=(await options.journal.get<AnalysisJob<Input>>(key))!;
    if(!claimed||!options.active())return latest;
    try {await options.port.submit(job.input);}
    catch{return options.active()?options.journal.update<AnalysisJob<Input>>(key,current=>current!.phase==='submitting'?{...current!,status:{...job.status,state:'unknown',code:'AUTOMATION_ADMISSION_UNKNOWN'}}:current!):latest;}
    return latest;
}
async function observeAnalysis<Target,Input>(options:KanbanAnalysisOptions<Target,Input>,key:string,job:AnalysisJob<Input>):Promise<AnalysisJob<Input>> {
    const observation=await options.port.inspect(job.id,job.input);
    if(!options.active()||observation.state==='running')return job;
    if(observation.state==='clarification')return options.journal.update<AnalysisJob<Input>>(key,current=>({...current!,phase:'waiting-input',status:{itemId:job.status.itemId,state:'clarification',reason:observation.reason??'PLANNING_INPUT_REQUIRED',code:observation.code}}));
    if(observation.state==='unknown')return options.journal.update<AnalysisJob<Input>>(key,current=>current!.phase==='submitting'?{...current!,status:{...job.status,state:'unknown',code:observation.code??'AUTOMATION_ADMISSION_UNKNOWN'}}:current!);
    if(observation.state==='failed'||observation.state==='cancelled')return saveFailure(options,key,job,observation.code??'AUTOMATION_ANALYSIS_FAILED',observation.state);
    try {
        requireValue(observation.output!==undefined,'AUTOMATION_ANALYSIS_INVALID');const analysis=parseAnalysis(observation.output);
        return options.journal.update<AnalysisJob<Input>>(key,current=>({...current!,phase:analysis.ready?'settled':'waiting-input',result:analysis,status:{itemId:job.status.itemId,state:analysis.ready?'ready':'clarification',reason:analysis.reason,dependencies:analysis.dependencies}}));
    }catch(error){return saveFailure(options,key,job,safeCode(error,'AUTOMATION_ANALYSIS_INVALID'));}
}
async function saveFailure<Target,Input>(options:KanbanAnalysisOptions<Target,Input>,key:string,job:AnalysisJob<Input>,code:string,terminalOutcome:'failed'|'cancelled'='failed'):Promise<AnalysisJob<Input>> {
    return options.journal.update<AnalysisJob<Input>>(key,current=>({...current!,phase:'settled',terminalOutcome,status:{itemId:job.status.itemId,state:'failed',code}}));
}
export function parseAnalysis(output: unknown): AnalysisResult {
    const result = output as AnalysisResult;
    requireValue(result && typeof result.ready === 'boolean' && typeof result.reason === 'string' && result.reason.length > 0 && result.reason.length <= 8000, 'AUTOMATION_ANALYSIS_INVALID');
    requireValue(Array.isArray(result.dependencies) && result.dependencies.length <= 100 && result.dependencies.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256), 'AUTOMATION_DEPENDENCIES_INVALID');
    if (result.estimate) requireValue(['low', 'medium', 'high'].includes(result.estimate.confidence)
        && [result.estimate.complexity, result.estimate.workUnits, result.estimate.durationMs].every(value => Number.isFinite(value) && value > 0), 'AUTOMATION_ESTIMATE_INVALID');
    const subtasks=validateSubtasks(result.subtasks);
    return {ready: result.ready, reason: result.reason, dependencies: [...new Set(result.dependencies)], ...(subtasks?{subtasks}:{}), ...(result.estimate ? {estimate: result.estimate} : {})};
}async function adoptAnalysis<Input>(journal:KanbanAutomationJournal, snapshot: KanbanBoard, item: KanbanItem, job: AnalysisJob<Input>, service: KanbanService, inherited: KanbanExternalReference[]): Promise<void> {
    if ((await service.workflow(snapshot.id)).plans[job.id]) return;
    const board = await service.read(snapshot.id), current = board.items.find(candidate => candidate.id === item.id);
    requireValue(board.automation?.enabled && current && analysisSignature(board,job.signatureVersion===2?item.id:undefined) === job.signature, 'AUTOMATION_ANALYSIS_STALE');
    requireValue(board.policy.requireEstimate === false || job.result?.estimate, 'ESTIMATE_REQUIRED');
    const dependencies = [...new Set([...(item.planning?.dependencies ?? []), ...job.result!.dependencies])];
    if(kanbanTaskType(item)==='coordination'&&!job.result?.subtasks?.length){
        return adoptDecomposition(journal,board,item,{id:job.id,reason:job.result!.reason,dependencies,subtasks:[{key:'execute',title:item.title,responsibility:item.responsibility,acceptance:item.acceptance,dependsOn:[],estimate:job.result?.estimate}]},service,inherited);
    }
    if(job.result?.subtasks?.length) return adoptDecomposition(journal,board,item,{id:job.id,reason:job.result.reason,dependencies,subtasks:job.result.subtasks},service,inherited);
    await service.execute(board.id, {operationId: 'analysis-plan:' + job.id, expectedRevision: board.revision, command: {type: 'publish-plan', plan: {
        schema: 'kanban.plan/1', id: job.id, revision: 1, sealed: true,
        items: [{id: item.id, title: item.title, responsibility: item.responsibility, acceptance: item.acceptance,
            expectedRevision: current!.revision, assignee: board.automation.worker, dependsOn: dependencies, outputs: ['result']}],
    }}});
}
