import type {KanbanClient,KanbanRecordConversation} from '../contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import {requireValue} from '../rules';
import {safeCode} from './diagnostics';
export interface SavedRecordConversation extends KanbanRecordConversation {binding?:unknown;submitted?:boolean;phase:'prepared'|'submitting'}
export interface RecordConversationPort {
    prepare(id:string,boardId:string):Promise<unknown>;
    start(binding:unknown,first:boolean,active:()=>boolean):Promise<{sessionId:string;resourceId:string}>;
    advance(conversation:SavedRecordConversation,active:()=>boolean):Promise<Partial<Pick<SavedRecordConversation,'recordId'|'state'|'code'>>>;
    watch(conversation:SavedRecordConversation,wake:()=>void):Promise<()=>Promise<void>>;
    close():Promise<void>;
}
interface Options {service:KanbanClient;journal:KanbanAutomationJournal;port:RecordConversationPort;log(event:{operationId:string;boardId:string;stage:string;result:'success'|'failure';code?:string;durationMs:number}):void}
const key=(id:string)=>'record-conversation:'+id;
export interface KanbanRecordConversations {
    startRecordConversation(board:string,request:{operationId:string}):Promise<KanbanRecordConversation>;
    recordConversations(board:string):Promise<KanbanRecordConversation[]>;
    scan():Promise<void>;quiesce():Promise<void>;
}
export function createRecordConversations(options:Options):KanbanRecordConversations {return new RecordConversations(options);}
/** Sessions own dialogue; immutable requests and domain commands own all mutations. */
class RecordConversations {
    private stopped=false;
    private readonly pending=new Map<string,Promise<unknown>>();
    private readonly watches=new Map<string,Promise<()=>Promise<void>>>();
    constructor(private readonly options:Options) {}
    private active=()=>!this.stopped;
    private serial<T>(id:string,work:()=>Promise<T>):Promise<T> {
        requireValue(this.active(),'SERVICE_STOPPING');const next=(this.pending.get(id)??Promise.resolve()).catch(()=>{}).then(work);this.pending.set(id,next);
        void next.finally(()=>{if(this.pending.get(id)===next)this.pending.delete(id);}).catch(()=>{});return next;
    }
    private async advance(id:string):Promise<void> {
        const old=await this.options.journal.get<SavedRecordConversation>(key(id));requireValue(old,'CONVERSATION_NOT_FOUND');
        if(!this.active())return;
        try {const update=await this.options.port.advance(old,this.active);if(Object.keys(update).length)await this.options.journal.update<SavedRecordConversation>(key(id),value=>({...value!,...update}));}
        catch(error){await this.failure(old,error,'decision.conversation.observe');}
    }
    private async failure(saved:SavedRecordConversation,error:unknown,stage:string):Promise<void> {
        const code=safeCode(error,'CONVERSATION_FAILED');
        if(saved.state==='error'&&saved.code===code)return;
        this.options.log({operationId:saved.id,boardId:saved.boardId,stage,result:'failure',code,durationMs:0});
        if(code!=='SERVICE_STOPPING')await this.options.journal.update<SavedRecordConversation>(key(saved.id),old=>({...old!,state:'error',code}));
    }
    private async watch(saved:SavedRecordConversation):Promise<void> {
        if(this.watches.has(saved.id))return;
        const opened=this.options.port.watch(saved,()=>{if(this.active())void this.serial(saved.id,()=>this.advance(saved.id)).catch(()=>{});});this.watches.set(saved.id,opened);
        try{await opened;}catch(error){this.watches.delete(saved.id);throw error;}
    }
    startRecordConversation=(boardId:string,request:{operationId:string}):Promise<KanbanRecordConversation>=>this.serial(request.operationId,()=>this.start(boardId,request.operationId));
    private async start(boardId:string,id:string):Promise<KanbanRecordConversation> {
        requireValue(/^[a-zA-Z0-9_-]{1,128}$/.test(id),'INVALID_OPERATION_ID');await this.options.service.read(boardId);
        let saved=await this.options.journal.update<SavedRecordConversation>(key(id),old=>{requireValue(!old||old.boardId===boardId,'IDEMPOTENCY_CONFLICT');return old??{id,boardId,state:'preparing',phase:'prepared',createdAt:Date.now()};});
        try {
            if(!saved.binding){const binding=await this.options.port.prepare(id,boardId);saved=await this.options.journal.update<SavedRecordConversation>(key(id),old=>({...old!,binding:old!.binding??binding}));}
            requireValue(this.active(),'SERVICE_STOPPING');
            if(!saved.sessionId){const result=await this.options.port.start(saved.binding,await this.options.journal.claim(key(id)),this.active);saved=await this.options.journal.update<SavedRecordConversation>(key(id),old=>({...old!,...result,state:'clarifying',code:undefined}));}
            requireValue(this.active(),'SERVICE_STOPPING');await this.watch(saved);await this.advance(id);
            return publicView((await this.options.journal.get<SavedRecordConversation>(key(id)))!);
        }catch(error){await this.failure(saved,error,'decision.conversation.start');throw error;}
    }
    recordConversations=async(boardId:string)=>{await this.options.service.read(boardId);return (await this.options.journal.find<SavedRecordConversation>('record-conversation:',value=>value.boardId===boardId)).map(row=>publicView(row.value));};
    scan=async()=>{
        for(const row of await this.options.journal.find<SavedRecordConversation>('record-conversation:',value=>!!value.binding)) {
            if(!this.active()||this.pending.size>=2)return;
            if(!this.watches.has(row.value.id))void this.startRecordConversation(row.value.boardId,{operationId:row.value.id}).catch(()=>{});
        }
    };
    quiesce=async()=>{this.stopped=true;await Promise.allSettled([...this.pending.values()]);await Promise.allSettled([...this.watches.values()].map(async opened=>(await opened)()));await this.options.port.close();};
}
function publicView(value:SavedRecordConversation):KanbanRecordConversation {
    const {binding:_binding,submitted:_submitted,phase:_phase,...view}=value;return view;
}
