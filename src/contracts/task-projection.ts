import type {KanbanDispatch,KanbanItem,KanbanItemSummary,KanbanWorkflowState,KanbanTaskProjection,KanbanTaskPhase} from './index';

type Item=Pick<KanbanItem,'deletedAt'|'id'|'status'|'createdAt'|'launch'|'analysis'|'control'|'issues'|'blocked'|'externalRefs'|'planning'>;
type Fact={phase:KanbanTaskPhase;reason?:string;actions?:KanbanTaskProjection['actions']};
export const TASK_START_DELAY_MS=300000;
export function taskStartAt(item:Pick<Item,'createdAt'|'launch'>):number {return item.launch?.startAt??item.createdAt+TASK_START_DELAY_MS;}
export function taskEditing(item:Pick<Item,'launch'>,now:number):boolean {return (item.launch?.editing?.expiresAt??0)>now;}
export function taskDue(item:Item,now:number):boolean {
    return !taskEditing(item,now)&&!item.blocked&&(!item.control || item.control.action === 'resume' && item.control.state === 'resumed')
        &&(item.launch?.requestedAt!==undefined||item.launch?.mode!=='manual'&&taskStartAt(item)<=now);
}
/** Ordered evidence projection shared by storage queries, CLI and UI. Session idle never proves acceptance. */
export function projectKanbanTask(item:Item,workflow?:KanbanWorkflowState,now=Date.now(),all:Array<Pick<KanbanItemSummary,'id'|'status'>>=[]):KanbanTaskProjection {
    const dispatch=Object.values(workflow?.dispatches??{}).filter(d=>d.itemId===item.id).sort((a,b)=>b.attempt-a.attempt)[0];
    const fact=terminalFact(item)??controlFact(item)??issueFact(item,dispatch)??failureFact(item,dispatch)??executionFact(item,dispatch)??waitingFact(item,now,all);
    const extra: KanbanTaskProjection['actions'] = [];
    if (!['completed','cancelled'].includes(item.status) && item.control?.action !== 'cancel') {
        if (!fact.actions?.includes('cancel')) extra.push('cancel');
        if (item.status !== 'review' && !fact.actions?.includes('pause') && !fact.actions?.includes('resume') && (dispatch?.controlCapabilities?.pause === 'boundary' || !dispatch)) extra.push('pause');
    }
    return {...fact,startAt:taskStartAt(item),dispatchId:dispatch?.id,sessionId:dispatch?.executionSessionId,
        actions:item.deletedAt === undefined ? [...fact.actions??[],...extra,...(dispatch||item.launch?.admittedAt!==undefined||['claimed','review','completed'].includes(item.status)?['fix' as const]:[]),...(dispatch?.executionSessionId?['open-session' as const]:[])] : []};
}
function terminalFact(item:Item):Fact|undefined {
    if(item.status==='completed'||item.status==='cancelled')return {phase:item.status,actions:['delete']};
    if(item.control?.action==='cancel')return {phase:item.control.state==='failed'?'error':item.control.state==='unknown'?'unknown':'cancelling',reason:item.control.code,actions:item.control.state==='failed'?['cancel']:[]};
    if(item.status==='review')return {phase:'review',actions:['review']};
}
function issueFact(item:Item,dispatch?:KanbanDispatch):Fact|undefined {
    const issue=item.issues?.find(i=>!i.resolvedBy&&(!dispatch||i.attemptId===dispatch.id));
    if(issue)return {phase:issue.type==='clarification'?'waiting-input':'error',reason:issue.id,actions:['resolve']};
}
function controlFact(item:Item):Fact|undefined {
    const control=item.control;if(!control)return;
    const reason=control.code;
    if(control.state==='unknown')return {phase:'unknown',reason};
    if(control.state==='failed')return {phase:'error',reason,actions:['resume']};
    if(control.action==='pause')return {phase:control.state==='paused'?'paused':'pausing',reason,actions:['resume']};
    if(['requested','accepted'].includes(control.state))return {phase:'resuming',reason};
}
function failureFact(item:Item,dispatch?:KanbanDispatch):Fact|undefined {
    if(dispatch?.outcome==='unknown'||item.analysis?.state==='unknown')return {phase:'unknown',reason:dispatch?.code??item.analysis?.code};
    if(dispatch&&['failed','cancelled','rejected'].includes(dispatch.outcome))return {phase:'error',reason:dispatch.code??dispatch.outcome};
    if(item.analysis?.state==='failed')return {phase:'error',reason:item.analysis.code};
}
function executionFact(item:Item,dispatch?:KanbanDispatch):Fact|undefined {
    if(item.blocked)return {phase:item.blocked.reason==='WORKSPACE_INPUT_REQUIRED'?'waiting-input':'error',reason:item.blocked.reason};
    if(dispatch?.outcome==='prepared')return {phase:'preparing'};
    if(dispatch?.outcome==='running'||item.status==='claimed')return {phase:'running',actions:dispatch?.controlCapabilities?.pause==='boundary'?['pause']:[]};
}
function waitingFact(item:Item,now:number,all:Array<Pick<KanbanItemSummary,'id'|'status'>>):Fact {
    const analysis=analysisFact(item);if(analysis)return analysis;
    const dependency=item.planning?.dependencies.find(id=>all.find(i=>i.id===id)?.status!=='completed');
    if(dependency)return {phase:'waiting-dependency',reason:'DEPENDENCY_UNFINISHED:'+dependency,actions:item.launch?.admittedAt===undefined?['edit','cancel']:[]};
    if(taskEditing(item,now))return {phase:'waiting-start',reason:'EDIT_LEASE_ACTIVE'};
    if(item.launch?.admittedAt!==undefined)return {phase:'queued'};
    return {phase:'waiting-start',reason:item.launch?.mode==='manual'?'MANUAL_START_REQUIRED':taskDue(item,now)?'ADMISSION_PENDING':'START_AT_PENDING',actions:['run','edit','pause','cancel']};
}
function analysisFact(item:Item):Fact|undefined {
    if(item.analysis?.state==='clarification')return {phase:'waiting-input',reason:item.analysis.reason};
    if(item.analysis?.state==='analyzing')return {phase:'analyzing'};
}
