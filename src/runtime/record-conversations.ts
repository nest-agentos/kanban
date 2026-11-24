import type {KanbanRecordDraftRemovalRequest,KanbanRecordDraftRemovalResult} from '../contracts';
import {conversationDraftRemovalBlocker,conversationAttentionFingerprint,type KanbanRecordConversationControl} from '../contracts';
import type {KanbanClient,KanbanRecordConversation,KanbanRecordConversationRequest} from '../contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import {validateRecurrence} from '../recurrence-validation';
import {requireValue} from '../rules';
import {safeCode} from './diagnostics';
export interface SavedRecordConversation extends KanbanRecordConversation {binding?:unknown;submitted?:boolean;clearedAt?:number;phase:'prepared'|'submitting'}
export interface RecordConversationPort {
    prepare(id:string,boardId:string,resources?:KanbanRecordConversation['resources'],primaryResource?:KanbanRecordConversation['primaryResource'],moduleIds?:string[],sourceSession?:KanbanRecordConversation['sourceSession']):Promise<unknown>;
    start(binding:unknown,first:boolean,active:()=>boolean):Promise<{sessionId:string;resourceId:string}>;
    advance(conversation:SavedRecordConversation,active:()=>boolean):Promise<Partial<Pick<SavedRecordConversation,'recordId'|'state'|'code'|'pendingReports'|'purpose'>>>;
    watchKey?(conversation:SavedRecordConversation):string;
    watch(conversation:SavedRecordConversation,wake:()=>void):Promise<()=>Promise<void>>;
    verifyDraftRemoval?(conversation:SavedRecordConversation):Promise<void>;
    referenceUnavailable?(conversation:SavedRecordConversation):Promise<boolean>;
    close():Promise<void>;
}
interface Options {service:KanbanClient;journal:KanbanAutomationJournal;port:RecordConversationPort;log(event:{operationId:string;boardId:string;stage:string;result:'success'|'failure';code?:string;durationMs:number}):void}
const key=(id:string)=>'record-conversation:'+id;
export interface KanbanRecordConversations {
    startRecordConversation(board:string,request:KanbanRecordConversationRequest):Promise<KanbanRecordConversation>;
    removeRecordConversations(board:string,request:KanbanRecordDraftRemovalRequest):Promise<KanbanRecordDraftRemovalResult>;
    controlRecordConversation(board:string,request:KanbanRecordConversationControl):Promise<void>;
    recordConversations(board:string):Promise<KanbanRecordConversation[]>;
    scan():Promise<void>;quiesce():Promise<void>;
}
export function createRecordConversations(options:Options):KanbanRecordConversations {return new RecordConversations(options);}
/** Sessions own dialogue; immutable requests and domain commands own all mutations. */
class RecordConversations {
    private stopped=false;
    private readonly pending=new Map<string,Promise<unknown>>();
    private readonly restoring=new Set<string>();
    private readonly watches=new Map<string,Promise<()=>Promise<void>>>();
    private readonly watchKeys=new Map<string,string>();
    constructor(private readonly options:Options) {}
    private active=()=>!this.stopped;
    private serial<T>(id:string,work:()=>Promise<T>):Promise<T> {
        requireValue(this.active(),'SERVICE_STOPPING');const next=(this.pending.get(id)??Promise.resolve()).catch(()=>{}).then(work);this.pending.set(id,next);
        void next.finally(()=>{if(this.pending.get(id)===next)this.pending.delete(id);}).catch(()=>{});return next;
    }
    private async advance(id:string):Promise<void> {
        const old=await this.options.journal.get<SavedRecordConversation>(key(id));requireValue(old,'CONVERSATION_NOT_FOUND');
        if(!this.active()||old.clearedAt!==undefined)return;
        try {const update=await this.options.port.advance(old,this.active);if(Object.keys(update).some(field=>JSON.stringify(old[field as keyof SavedRecordConversation])!==JSON.stringify(update[field as keyof typeof update])))await this.options.journal.update<SavedRecordConversation>(key(id),value=>({...value!,...update,lastActivityAt:Date.now()}));}
        catch(error){await this.failure(old,error,'decision.conversation.observe');}
    }
    private async failure(saved:SavedRecordConversation,error:unknown,stage:string):Promise<void> {
        const code=safeCode(error,'CONVERSATION_FAILED');
        if(saved.state==='error'&&saved.code===code)return;
        this.options.log({operationId:saved.id,boardId:saved.boardId,stage,result:'failure',code,durationMs:0});
        if(code!=='SERVICE_STOPPING')await this.options.journal.update<SavedRecordConversation>(key(saved.id),old=>old?.clearedAt!==undefined?old:({...old!,state:'error',code,lastActivityAt:Date.now()}));
    }
    private async watch(saved:SavedRecordConversation):Promise<void> {
        const key=this.options.port.watchKey?.(saved)??saved.id;
        if(this.watches.has(saved.id)&&this.watchKeys.get(saved.id)===key)return;
        await this.closeWatch(saved.id);this.watchKeys.set(saved.id,key);
        const opened=this.options.port.watch(saved,()=>{if(this.active())void this.serial(saved.id,()=>this.advance(saved.id)).catch(()=>{});});this.watches.set(saved.id,opened);
        try{await opened;}catch(error){this.watches.delete(saved.id);this.watchKeys.delete(saved.id);throw error;}
    }
    startRecordConversation=(boardId:string,request:KanbanRecordConversationRequest):Promise<KanbanRecordConversation>=>this.serial(request.operationId,()=>this.start(boardId,request));
    private async start(boardId:string,request:KanbanRecordConversationRequest):Promise<KanbanRecordConversation> {
        const {operationId:id,moduleIds,recurrence,sourceSession}=request;
        if(sourceSession)requireValue(!!recurrence&&[sourceSession.projectId,sourceSession.profileId,sourceSession.sessionId].every(value=>typeof value==='string'&&value.length>0&&value.length<=256),'INVALID_DECISION_SOURCE_SESSION');
        if(recurrence!==undefined&&recurrence!==null)validateRecurrence(recurrence);
        requireValue(moduleIds===undefined||Array.isArray(moduleIds)&&moduleIds.length<=16&&moduleIds.every(id=>typeof id==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(id))&&new Set(moduleIds).size===moduleIds.length,'DECISION_MODULES_INVALID');
        requireValue(/^[a-zA-Z0-9_-]{1,128}$/.test(id),'INVALID_OPERATION_ID');await this.options.service.read(boardId);
        let saved=await this.options.journal.update<SavedRecordConversation>(key(id),old=>{
            requireValue(old?.clearedAt===undefined,'CONVERSATION_REFERENCE_CLEARED');
            requireValue(!old||old.boardId===boardId,'IDEMPOTENCY_CONFLICT');
            const select=old&&old.resources===undefined&&!old.binding&&old.phase==='prepared'&&request.resources!==undefined;
            requireValue(select||!old||request.resources===undefined||JSON.stringify(old.resources)===JSON.stringify(request.resources),'IDEMPOTENCY_CONFLICT');
            requireValue(select||!old||request.primaryResource===undefined||JSON.stringify(old.primaryResource)===JSON.stringify(request.primaryResource),'IDEMPOTENCY_CONFLICT');
            requireValue(select||!old||request.moduleIds===undefined||JSON.stringify(old.moduleIds??[])===JSON.stringify(request.moduleIds),'IDEMPOTENCY_CONFLICT');
            requireValue(!old||recurrence===undefined||select&&old.recurrence===undefined||JSON.stringify(old.recurrence??null)===JSON.stringify(recurrence),'IDEMPOTENCY_CONFLICT');
            requireValue(!old||sourceSession===undefined||JSON.stringify(old.sourceSession)===JSON.stringify(sourceSession),'IDEMPOTENCY_CONFLICT');
            const mode=recurrence===undefined?{}:{recurrence:structuredClone(recurrence)};
            if(select)return {...old,...mode,resources:structuredClone(request.resources!),primaryResource:request.primaryResource?structuredClone(request.primaryResource):undefined,moduleIds:request.moduleIds?.slice()};
            return old??{id,boardId,...mode,...(sourceSession?{sourceSession:structuredClone(sourceSession)}:{}),state:'preparing',phase:'prepared',createdAt:Date.now(),...(request.moduleIds?.length?{moduleIds:request.moduleIds.slice()}:{}),...(request.resources?{resources:structuredClone(request.resources)}:{}),...(request.primaryResource?{primaryResource:structuredClone(request.primaryResource)}:{})};});
        try {
            if(!saved.binding){
                const args: [modules?:string[],source?:KanbanRecordConversation['sourceSession']]=saved.sourceSession?[saved.moduleIds,saved.sourceSession]:saved.moduleIds?.length?[saved.moduleIds]:[];
                const binding=await this.options.port.prepare(id,boardId,saved.resources,saved.primaryResource,...args);
                saved=await this.options.journal.update<SavedRecordConversation>(key(id),old=>({...old!,binding:old!.binding??binding}));
            }
            requireValue(this.active(),'SERVICE_STOPPING');
            if(!saved.sessionId){const result=await this.options.port.start(saved.binding,await this.options.journal.claim(key(id)),this.active);saved=await this.options.journal.update<SavedRecordConversation>(key(id),old=>({...old!,...result,state:'clarifying',code:undefined,lastActivityAt:Date.now()}));}
            requireValue(this.active(),'SERVICE_STOPPING');await this.watch(saved);await this.advance(id);
            return publicView((await this.options.journal.get<SavedRecordConversation>(key(id)))!);
        }catch(error){await this.failure(saved,error,'decision.conversation.start');throw error;}
    }
    removeRecordConversations=async(board:string,request:KanbanRecordDraftRemovalRequest):Promise<KanbanRecordDraftRemovalResult>=>{
        requireValue(request&&Array.isArray(request.requests)&&request.requests.length>0&&request.requests.length<=100,'INVALID_RECORD_CONTROL');
        requireValue(request.requests.every(row=>row&&row.action==='remove-draft'&&typeof row.conversationId==='string'&&typeof row.operationId==='string')&&new Set(request.requests.map(row=>row.conversationId)).size===request.requests.length,'INVALID_RECORD_CONTROL');
        const items:KanbanRecordDraftRemovalResult['items']=[];
        for(const row of request.requests){
            try {await this.controlRecordConversation(board,row);items.push({conversationId:row.conversationId,outcome:'removed'});}
            catch(error){const code=safeCode(error,'CONVERSATION_CONTROL_FAILED'),unknown=(error as {outcome?:string})?.outcome==='unknown'||['EIO','HTTP_CONNECTION_LOST','ETIMEOUT'].includes(code);
                items.push({conversationId:row.conversationId,outcome:unknown?'unknown':'failed',code});}
        }
        return {items};
    };
    controlRecordConversation=(boardId:string,request:KanbanRecordConversationControl):Promise<void>=>this.serial(request.conversationId,async()=>{
        const started=Date.now();
        try {await this.control(boardId,request);this.options.log({operationId:request.operationId,boardId,stage:'conversation.reference.'+request.action,result:'success',durationMs:Date.now()-started});}
        catch(error){this.options.log({operationId:request.operationId,boardId,stage:'conversation.reference.'+request.action,result:'failure',code:safeCode(error,'CONVERSATION_CONTROL_FAILED'),durationMs:Date.now()-started});throw error;}
    });
    private async control(boardId:string,request:KanbanRecordConversationControl):Promise<void> {
        requireValue(/^[a-zA-Z0-9_-]{1,128}$/.test(request.operationId)&&/^[a-f0-9]{64}$/.test(request.fingerprint)&&['dismiss-attention','cleanup-reference','remove-draft'].includes(request.action),'INVALID_RECORD_CONTROL');
        const [board,actor]=await Promise.all([this.options.service.read(boardId),this.options.service.currentPrincipal()]);
        requireValue(actor.kind==='human'&&board.members?.some(row=>row.kind===actor.kind&&row.id===actor.id&&row.roles?.includes('coordinator')),'COORDINATOR_REQUIRED');
        const receiptKey='conversation-control:'+request.operationId,identity=JSON.stringify([boardId,request.conversationId,request.action,request.fingerprint]);
        const receipt=await this.options.journal.get<string>(receiptKey);
        if(receipt){requireValue(receipt===identity,'IDEMPOTENCY_CONFLICT');if(request.action!=='dismiss-attention')await this.closeWatch(request.conversationId);return;}
        const saved=await this.options.journal.get<SavedRecordConversation>(key(request.conversationId));
        requireValue(saved&&saved.boardId===boardId,'CONVERSATION_NOT_FOUND');requireValue(!saved.recordId,'CONVERSATION_HAS_RECORD');
        requireValue(saved.clearedAt===undefined&&conversationAttentionFingerprint({...saved,attentionFingerprint:undefined})===request.fingerprint,'DECISION_ATTENTION_CHANGED');
        await this.verifyRemoval(saved,request);
        await this.options.journal.updateMany([{key:receiptKey,change:old=>{requireValue(!old||old===identity,'IDEMPOTENCY_CONFLICT');return identity;}},
            {key:key(saved.id),change:value=>{
                const old=value as SavedRecordConversation|undefined;
                requireValue(old&&old.boardId===boardId&&conversationAttentionFingerprint({...old,attentionFingerprint:undefined})===request.fingerprint&&old.clearedAt===undefined,'DECISION_ATTENTION_CHANGED');
                return {...old,...(request.action!=='dismiss-attention'?{clearedAt:Date.now()}:{attentionDismissal:{fingerprint:request.fingerprint,operationId:request.operationId,at:Date.now()}})};
            }}]);
        if(request.action!=='dismiss-attention')await this.closeWatch(saved.id);
    }
    private async verifyRemoval(saved:SavedRecordConversation,request:KanbanRecordConversationControl):Promise<void> {
        if(request.action==='remove-draft'){
            requireValue(request.confirmed===true,'CONVERSATION_REMOVE_CONFIRM_REQUIRED');
            const blocker=conversationDraftRemovalBlocker(saved);requireValue(!blocker,blocker??'CONVERSATION_HAS_RECORD');
            requireValue(saved.phase!=='submitting'||!!saved.sessionId,'CONVERSATION_SUBMISSION_UNSETTLED');
            requireValue(this.options.port.verifyDraftRemoval,'CONVERSATION_DRAFT_REMOVAL_UNAVAILABLE');
            await this.options.port.verifyDraftRemoval(saved);
        }
        if(request.action==='cleanup-reference'){
            requireValue(request.confirmed===true,'CONVERSATION_CLEANUP_CONFIRM_REQUIRED');
            requireValue(await this.options.port.referenceUnavailable?.(saved),'CONVERSATION_REFERENCE_STILL_AVAILABLE');
        }
    }
    private async closeWatch(id:string):Promise<void> {const watch=this.watches.get(id);if(watch){try{await(await watch)();}finally{this.watches.delete(id);this.watchKeys.delete(id);}}}
    recordConversations=async(boardId:string)=>{await this.options.service.read(boardId);return (await this.options.journal.find<SavedRecordConversation>('record-conversation:',value=>value.boardId===boardId&&value.clearedAt===undefined)).map(row=>publicView(row.value));};
    scan=async()=>{
        for(const row of await this.options.journal.find<SavedRecordConversation>('record-conversation:',value=>!!value.binding&&value.clearedAt===undefined)) {
            if(!this.active())return;
            const saved=row.value;
            if(this.pending.has(saved.id)||this.watches.has(saved.id)&&this.watchKeys.get(saved.id)===(this.options.port.watchKey?.(saved)??saved.id))continue;
            if(this.restoring.size>=2)return;
            this.restoring.add(saved.id);
            void this.startRecordConversation(saved.boardId,{operationId:saved.id}).catch(()=>{}).finally(()=>this.restoring.delete(saved.id));
        }
    };
    quiesce=async()=>{this.stopped=true;await Promise.allSettled([...this.pending.values()]);await Promise.allSettled([...this.watches.values()].map(async opened=>(await opened)()));await this.options.port.close();};
}
function publicView(value:SavedRecordConversation):KanbanRecordConversation {
    const {binding:_binding,submitted:_submitted,phase:_phase,clearedAt:_clearedAt,...view}=value;return {...view,attentionFingerprint:conversationAttentionFingerprint({...value,attentionFingerprint:undefined}),scopeSelectionRequired:!value.resources&&!value.binding&&value.phase==='prepared'};
}
