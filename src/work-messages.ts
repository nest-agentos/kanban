import {FSError, type IFileSystem} from '@nestos/vfs-core';
import {sha256HexSync} from './utils';
export interface WorkMessageScope {runId:string;itemId:string;attemptId:string}
export interface WorkMessage extends WorkMessageScope {schema:'work-message/1'|'work-message/2';id:string;type:'progress'|'clarification'|'error'|'result'|'resolved';content:string;replyTo?:string}
interface Journal {get<T>(key:string):Promise<T|undefined>;update<T>(key:string,change:(old:T|undefined)=>T):Promise<T>}
interface Receipt {digest:string;message:WorkMessage;delivered:boolean}
/** Directory events are wakeups; immutable files plus durable receipts are authoritative. */
export async function consumeWorkMessages(fs:IFileSystem,directory:string,scope:WorkMessageScope,journal:Journal,
    deliver:(message:WorkMessage)=>Promise<void|{pending:true}>,decode:(text:string)=>unknown,publishReply:(directory:string,name:string,content:string)=>Promise<void>):Promise<WorkMessage[]> {
    const publications=await readPublications(fs,directory,scope,decode),indexKey='workspace-message-index:'+scope.attemptId;
    const known=await journal.get<string[]>(indexKey)??[];
    if(known.some(id=>!publications.some(p=>p.message.id===id)))throw protocolError('WORK_MESSAGE_MISSING','Published workspace message is missing','ECONFLICT');
    unresolvedWorkIssues(publications.map(p=>p.message));
    publications.sort((a,b)=>Number(a.message.type==='resolved')-Number(b.message.type==='resolved'));
    for(const {message,bytes} of publications) {
        const digest=sha256HexSync(bytes);
        const delivered=await deliverPublication(journal,indexKey,message,digest,deliver);
        if(delivered)await publishReply(directory+'/outbox','ack-'+message.id+'.yaml',JSON.stringify({schema:'work-reply/1',...scope,id:'ack-'+message.id,type:'accepted',replyTo:message.id,content:'Accepted',digest}));
    }
    return publications.map(p=>p.message);
}
async function readPublications(fs:IFileSystem,directory:string,scope:WorkMessageScope,decode:(text:string)=>unknown) {
    const files=await fs.driver.getChildren(directory+'/inbox',{fields:'entry'}),publications:Array<{message:WorkMessage;bytes:ArrayBuffer}>=[];
    if(files.length>200)throw protocolError('WORK_MESSAGE_COUNT_LIMIT','Workspace inbox exceeds 200 entries');
    for(const file of files.sort((a,b)=>a.name.localeCompare(b.name))) {
        if(file.type!=='file'||!/^[a-zA-Z0-9_-]{1,128}\.(yaml|yml|json)$/.test(file.name))continue;
        const bytes=await readMessageBytes(fs,directory+'/inbox/'+file.name);
        const text = new TextDecoder('utf-8',{fatal:true}).decode(bytes), envelope = decode(text) as {schema?: string; scopeId?: string};
        if (envelope?.schema === 'work-message/2' && Object.hasOwn(envelope, 'scopeId')) continue;
        const message=parseWorkMessage(text,scope,decode);
        if(file.name.slice(0,file.name.lastIndexOf('.'))!==message.id)throw protocolError('WORK_MESSAGE_FILENAME_MISMATCH','Workspace message filename does not match its identity');
        publications.push({message,bytes});
    }
    return publications;
}
async function deliverPublication(journal:Journal,indexKey:string,message:WorkMessage,digest:string,deliver:(message:WorkMessage)=>Promise<void|{pending:true}>):Promise<boolean> {
    const key='workspace-message:'+message.attemptId+':'+message.id;
    const receipt=await journal.update<Receipt>(key,old=>{
        if(old&&old.digest!==digest)throw protocolError('WORK_MESSAGE_CHANGED','Published workspace message changed','ECONFLICT');
        return old??{digest,message,delivered:false};
    });
    await journal.update<string[]>(indexKey,old=>old?.includes(message.id)?old:[...old??[],message.id]);
    if(receipt.delivered)return true;
    const outcome=await deliver(receipt.message);if(outcome?.pending)return false;
    await journal.update<Receipt>(key,old=>({...old!,delivered:true}));return true;
}

export function parseWorkMessage(text:string,scope:WorkMessageScope,decode:(text:string)=>unknown):WorkMessage {
    let value:WorkMessage;
    try {value=decode(text) as WorkMessage;} catch {throw protocolError('WORK_MESSAGE_YAML_INVALID','Workspace message is not valid bounded YAML');}
    if(!value||typeof value!=='object'||Array.isArray(value))throw protocolError('WORK_MESSAGE_SCHEMA_INVALID','Workspace message schema is invalid');
    if('body' in value) {
        if(Object.hasOwn(value,'content'))throw protocolError('WORK_MESSAGE_FIELDS_INVALID','Workspace message must not contain both body and content');
        value={...value,content:(value as WorkMessage&{body:string}).body};
    }
    if(Object.keys(value).some(key=>!['schema','runId','itemId','attemptId','id','type','content','body','replyTo'].includes(key)))
        throw protocolError('WORK_MESSAGE_FIELDS_INVALID','Workspace message contains undeclared fields');
    validateEnvelope(value,scope);return value;
}
function validateEnvelope(value:WorkMessage,scope:WorkMessageScope):void {
    if(!['work-message/1','work-message/2'].includes(value.schema))throw protocolError('WORK_MESSAGE_SCHEMA_INVALID','Workspace message schema is unsupported');
    if(!['progress','clarification','error','result',...(value.schema==='work-message/2'?['resolved']:[])].includes(value.type))
        throw protocolError('WORK_MESSAGE_TYPE_INVALID','Workspace message schema does not permit this type');
    if(!validId(value.id))throw protocolError('WORK_MESSAGE_ID_INVALID','Workspace message identity is invalid');
    if(['runId','itemId','attemptId'].some(key=>value[key as keyof WorkMessageScope]!==scope[key as keyof WorkMessageScope]))
        throw protocolError('WORK_MESSAGE_SCOPE_MISMATCH','Workspace message execution scope is invalid');
    if(typeof value.content!=='string'||!value.content.trim()||value.content.length>8000)throw protocolError('WORK_MESSAGE_CONTENT_INVALID','Workspace message content is invalid');
    if(value.replyTo!==undefined&&!validId(value.replyTo)||value.type==='resolved'&&!value.replyTo)
        throw protocolError('WORK_MESSAGE_REPLY_INVALID','Workspace message reply target is invalid');
}
function validId(value:unknown):value is string {return typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);}
function protocolError(reasonCode:string,message:string,code:'EINVAL'|'ECONFLICT'='EINVAL'):Error {
    return Object.assign(new FSError(code,message),{reasonCode});
}

/** Range reads must fit the advertised size; remote backends reject short ranges. */
async function readMessageBytes(fs: IFileSystem, path: string): Promise<ArrayBuffer> {
    const before = await fs.driver.getNode(path);
    if (before?.type !== 'file' || !Number.isSafeInteger(before.size) || before.size < 1) throw protocolError('WORK_MESSAGE_FILE_INVALID','Workspace message is not a nonempty regular file');
    if (before.size > 65536) throw protocolError('WORK_MESSAGE_SIZE_LIMIT','Workspace message exceeds 64 KiB');
    const bytes = await fs.driver.readContent(path, {encoding: 'binary', length: before.size});
    const after = await fs.driver.getNode(path);
    if (bytes.byteLength !== before.size || after?.type !== 'file' || after.size !== before.size
        || after.revision !== before.revision || after.modifiedAt !== before.modifiedAt)
        throw protocolError('WORK_MESSAGE_READ_CONFLICT','Workspace message changed while reading','ECONFLICT');
    return bytes;
}

/** Only explicit linked resolutions close issues; unrelated progress cannot erase them. */
export function unresolvedWorkIssues(messages: WorkMessage[]): WorkMessage[] {
    const issues = messages.filter(m => m.type === 'clarification' || m.type === 'error');
    for (const resolution of messages.filter(m => m.type === 'resolved')) {
        if (!issues.some(issue => issue.id === resolution.replyTo)) throw Object.assign(new Error('Resolution target is not an issue in this attempt'), {code:'WORKSPACE_RESOLUTION_INVALID'});
    }
    return issues.filter(issue => !messages.some(m => m.type === 'resolved' && m.replyTo === issue.id));
}
