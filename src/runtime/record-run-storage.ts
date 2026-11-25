import type {ISeqFileTransaction, ISeqFileOperations} from '@nestos/vfs-core';
import {sha256HexSync,randomUUID} from '../utils';
import {requireValue} from '../rules';
import type {KanbanRecordSummary} from '../contracts';
import type {RecordRun} from './record-progress-groups';
import type {KanbanRuntimeDiagnostic} from './ports';
import {safeCode} from './diagnostics';
type Reader=Pick<ISeqFileOperations,'getEntry'|'getEntries'|'walkEntries'|'keyPages'|'ioctl'>;
type Saved=Record<string,unknown>&RecordRun;
type Hot=RecordRun&{details:string;epoch?:string;ordinal:number};
const family='record-runs:';
const marker=(count:number)=>JSON.stringify({recordRuns:1,count});
const hotFields=['id','recordId','recordRevision','boardId','rootItemId','itemIds','stage','state','createdAt','updatedAt','archivedAt','code','completion','dependencies','scheduledAt','recurrenceRevision','manualCardCount'];
const prefix=(board:string)=>'run:'+JSON.stringify([board]).slice(0,-1)+',';
const runKey=(board:string,id:string)=>'run:'+JSON.stringify([board,id]);
const activeKey=(board:string,id:string)=>'active:'+JSON.stringify([board,id]);
const activeRecordPrefix=(board:string,id:string)=>'active-record:'+JSON.stringify([board,id]).slice(0,-1)+',';
const activeRecordKey=(board:string,row:Hot)=>activeRecordPrefix(board,row.recordId)+JSON.stringify(row.id)+']';
const isActive=(row:Hot)=>!['completed','failed','cancelled'].includes(row.state);
const groupPrefix=(board:string,row:Hot)=>'by-record:'+JSON.stringify([board,row.recordId,row.epoch??null]).slice(0,-1)+',';
const groupKey=(board:string,row:Hot)=>groupPrefix(board,row)+JSON.stringify(row.id)+']';
const historyPrefix=(board:string,id:string)=>'history:'+JSON.stringify([board,id]).slice(0,-1)+',';
const historyKey=(board:string,row:Hot)=>historyPrefix(board,row.recordId)+JSON.stringify(String(Number.MAX_SAFE_INTEGER-row.createdAt).padStart(16,'0'))+','+JSON.stringify(row.id)+']';
const currentKey=(board:string,id:string,epoch:string|undefined,archived:boolean)=>'current:'+JSON.stringify([board,id,epoch??null,archived]);
export const isRunMarker=(key:string,raw:string|null)=>key.startsWith(family)&&!!raw?.startsWith('{"recordRuns":1,"count":');

/** Rows contain only frequently read metadata; frozen input lives in immutable detail rows. */
function splitRun(value:Saved,ordinal:number):{hot:Hot;body:string} {
    const metadata:Record<string,unknown>={},details={...value};
    for(const key of hotFields){if(value[key]!==undefined)metadata[key]=value[key];delete details[key];}
    const body=JSON.stringify(details),reference='detail:'+sha256HexSync(body);
    return {hot:{...metadata,ordinal,details:reference,epoch:value.record?.executionEpoch} as Hot,body};
}
function latest(board:string,rows:Hot[]):Map<string,Hot> {
    const selected=new Map<string,Hot>();
    for(const row of rows)for(const archived of [false,true]) {
        if(!archived&&row.archivedAt!==undefined)continue;
        const key=currentKey(board,row.recordId,row.epoch,archived),previous=selected.get(key);
        if(!previous||row.createdAt>previous.createdAt||row.createdAt===previous.createdAt&&row.updatedAt>previous.updatedAt)selected.set(key,row);
    }
    return selected;
}
function progressValue(row:Hot):RecordRun {
    const {details:_details,ordinal:_ordinal,epoch,...metadata}=row;
    return {...metadata,record:epoch===undefined?undefined:{executionEpoch:epoch}};
}
async function hotRows(reader:Reader,path:string,board:string):Promise<Hot[]> {
    const rows:Hot[]=[];
    await reader.walkEntries(path,entry=>{rows.push(JSON.parse(entry.value));return true;},{keyPrefix:prefix(board)});
    return rows.sort((a,b)=>a.ordinal-b.ordinal);
}
export async function readRunHistory(reader:Reader,path:string,key:string,expected?:number):Promise<Saved[]> {
    const rows=await hotRows(reader,path,key.slice(family.length));
    if(expected!==undefined)requireValue(rows.length===expected,'RECORD_RUN_STORAGE_INCOMPLETE');
    return restoreRows<Saved>(reader,path,rows);
}
/** Both hot rows and current-attempt indexes commit with the source journal reference. */
export async function writeRunHistory(tx:ISeqFileTransaction,path:string,source:string,key:string,previous:Saved[],values:Saved[]):Promise<void> {
    requireValue(Array.isArray(values),'INVALID_RECORD_RUNS');
    const board=key.slice(family.length),rows=values.map(splitRun),old=previous.length?await hotRows(tx,path,board):[],oldById=new Map(old.map(row=>[row.id,row])),seen=new Set<string>();
    requireValue(new Set(values.map(row=>row.id)).size===values.length,'DUPLICATE_RECORD_RUN');
    for(const {hot,body} of rows) {
        requireValue(typeof hot.id==='string'&&typeof hot.recordId==='string','INVALID_RECORD_RUN');seen.add(hot.id);
        await persistHot(tx,path,board,hot,body,oldById.get(hot.id));
    }
    for(const hot of old)if(!seen.has(hot.id)){await tx.deleteEntry(path,runKey(board,hot.id));await tx.deleteEntry(path,groupKey(board,hot));await tx.deleteEntry(path,historyKey(board,hot));if(isActive(hot)){await tx.deleteEntry(path,activeKey(board,hot.id));await tx.deleteEntry(path,activeRecordKey(board,hot));}}
    await writeCurrent(tx,path,board,old,rows.map(row=>row.hot));
    const reference=marker(values.length);if(await tx.getEntry(source,key)!==reference)await tx.setEntry(source,key,reference);
}
async function persistHot(tx:ISeqFileTransaction,path:string,board:string,hot:Hot,body:string,previous?:Hot):Promise<number> {
    const encoded=JSON.stringify(hot);if(JSON.stringify(previous)===encoded)return 0;
    let written=2;
    if(previous?.details!==hot.details&&await tx.getEntry(path,hot.details)===null){await tx.setEntry(path,hot.details,body);written++;}
    if(previous&&groupKey(board,previous)!==groupKey(board,hot)){await tx.deleteEntry(path,groupKey(board,previous));written++;}
    if(previous&&historyKey(board,previous)!==historyKey(board,hot)){await tx.deleteEntry(path,historyKey(board,previous));written++;}
    if(previous&&isActive(previous)&&activeRecordKey(board,previous)!==activeRecordKey(board,hot)){await tx.deleteEntry(path,activeRecordKey(board,previous));written++;}
    await tx.setEntry(path,runKey(board,hot.id),encoded);await tx.setEntry(path,groupKey(board,hot),encoded);
    await tx.setEntry(path,historyKey(board,hot),encoded);written++;
    if(isActive(hot)){await tx.setEntry(path,activeKey(board,hot.id),encoded);await tx.setEntry(path,activeRecordKey(board,hot),encoded);written+=2;}
    else if(previous&&isActive(previous)){await tx.deleteEntry(path,activeKey(board,hot.id));await tx.deleteEntry(path,activeRecordKey(board,previous));written+=2;}
    return written;
}
/** A cursor reads only a bounded window of the per-decision chronological index. */
export async function runHistoryPage(reader:Reader,path:string,board:string,recordId:string,limit:number,after?:string):Promise<{items:RecordRun[];active:RecordRun[];nextCursor?:string}> {
    requireValue(Number.isInteger(limit)&&limit>0&&limit<=50,'RECURRENCE_PAGE_INVALID');
    const keyPrefix=historyPrefix(board,recordId);requireValue(after===undefined||after.length<=512&&after.startsWith(keyPrefix),'RECURRENCE_CURSOR_INVALID');
    const page=await indexedWindow(reader,path,keyPrefix,limit,after),current=await indexedWindow(reader,path,activeRecordPrefix(board,recordId),50);
    requireValue(!current.next,'RECURRENCE_ACTIVE_LIMIT');
    return {items:page.rows.map(progressValue),active:current.rows.map(progressValue),...(page.next?{nextCursor:page.next}:{})};
}
async function indexedWindow(reader:Reader,path:string,keyPrefix:string,limit:number,after?:string):Promise<{rows:Hot[];next?:string}> {
    if(reader.keyPages&&reader.ioctl){
        const page=await reader.ioctl(path,'seq.keys.page.v1',{keyPrefix,limit,...(after?{after}:{})}) as {keys:string[];next?:string};
        const values=page.keys.length?await reader.getEntries(path,page.keys):{};
        return {rows:page.keys.map(key=>{requireValue(values[key]!==undefined,'RECORD_RUN_STORAGE_INCOMPLETE');return JSON.parse(values[key]) as Hot;}),...(page.next?{next:page.next}:{})};
    }
    const values:Array<{key:string;row:Hot}>=[];
    await reader.walkEntries(path,entry=>{values.push({key:entry.key,row:JSON.parse(entry.value)});return true;},{keyPrefix,order:'key',limit:limit+1,...(after?{after}:{})});
    const rows=values.slice(0,limit);return {rows:rows.map(row=>row.row),...(values.length>limit?{next:rows.at(-1)!.key}:{})};
}
/** Insert one recurring run without decoding unrelated history. */
export async function appendRecurringRun<T extends RecordRun>(tx:ISeqFileTransaction,path:string,source:string,board:string,value:T):Promise<T> {
    const existing=await tx.getEntry(path,runKey(board,value.id));
    if(existing)return (await restoreRows<T>(tx,path,[JSON.parse(existing)]))[0];
    const sourceKey=family+board,raw=await tx.getEntry(source,sourceKey);
    requireValue(raw===null||isRunMarker(sourceKey,raw),'RECORD_RUN_STORAGE_INCOMPLETE');
    const count=raw===null?0:(JSON.parse(raw) as {count:number}).count,{hot,body}=splitRun(value as Saved,count);
    await persistHot(tx,path,board,hot,body);await tx.setEntry(source,sourceKey,marker(count+1));
    for(const archived of [false,true]){
        const key=currentKey(board,hot.recordId,hot.epoch,archived),current=await tx.getEntry(path,key);
        const old=current?JSON.parse(current) as RecordRun:undefined;
        if(!old||hot.createdAt>old.createdAt||hot.createdAt===old.createdAt&&hot.updatedAt>old.updatedAt)await tx.setEntry(path,key,JSON.stringify(progressValue(hot)));
    }
    return value;
}
export async function migrateRunHistoryIndex(tx:ISeqFileTransaction,path:string):Promise<number> {
    if(await tx.getEntry(path,'history-version')==='2')return 0;let count=0;
    await tx.walkEntries(path,async entry=>{const [board]=JSON.parse(entry.key.slice(4)) as [string,string];const row=JSON.parse(entry.value) as Hot;await tx.setEntry(path,historyKey(board,row),entry.value);if(isActive(row))await tx.setEntry(path,activeRecordKey(board,row),entry.value);count++;return true;},{keyPrefix:'run:'});
    await tx.setEntry(path,'history-version','2');return count;
}
export async function runSummaries(reader:Reader,path:string,board:string,recordId?:string):Promise<RecordRun[]> {
    const rows:Hot[]=[];const keyPrefix=recordId===undefined?prefix(board):'by-record:'+JSON.stringify([board,recordId]).slice(0,-1)+',';
    await reader.walkEntries(path,entry=>{rows.push(JSON.parse(entry.value));return true;},{keyPrefix});
    return rows.sort((a,b)=>a.ordinal-b.ordinal).map(progressValue);
}
export async function activeRunHistory<T>(reader:Reader,path:string,board:string):Promise<T[]> {
    const rows:Hot[]=[];
    await reader.walkEntries(path,entry=>{rows.push(JSON.parse(entry.value));return true;},{keyPrefix:'active:'+JSON.stringify([board]).slice(0,-1)+','});
    return restoreRows<T>(reader,path,rows.sort((a,b)=>a.ordinal-b.ordinal));
}
/** Restore only unfinished runs owned by one decision. */
export async function activeRecordRuns<T>(reader:Reader,path:string,board:string,recordId:string):Promise<T[]> {
    const rows:Hot[]=[];
    await reader.walkEntries(path,entry=>{rows.push(JSON.parse(entry.value));return true;},{keyPrefix:activeRecordPrefix(board,recordId)});
    return restoreRows<T>(reader,path,rows.sort((a,b)=>a.ordinal-b.ordinal));
}
async function restoreRows<T>(reader:Reader,path:string,rows:Hot[]):Promise<T[]> {
    const values=rows.length?await reader.getEntries(path,[...new Set(rows.map(row=>row.details))]):{};
    return rows.map(row=>{
        requireValue(values[row.details]!==undefined,'RECORD_RUN_DETAILS_MISSING');
        const {details,ordinal:_ordinal,epoch:_epoch,...metadata}=row;return {...JSON.parse(values[details]),...metadata} as T;
    });
}
export async function readRun<T>(reader:Reader,path:string,board:string,id:string):Promise<T|undefined> {
    const raw=await reader.getEntry(path,runKey(board,id));if(!raw)return;
    return (await restoreRows<T>(reader,path,[JSON.parse(raw)]))[0];
}
async function writeCurrent(tx:ISeqFileTransaction,path:string,board:string,previous:Hot[],rows:Hot[]):Promise<number> {
    let written=0;const before=latest(board,previous),after=latest(board,rows);
    for(const key of before.keys())if(!after.has(key)){await tx.deleteEntry(path,key);written++;}
    for(const [key,row]of after) {
        const actual=key,value=JSON.stringify(progressValue(row));
        if(value!==JSON.stringify(before.has(key)?progressValue(before.get(key)!):undefined)){await tx.setEntry(path,actual,value);written++;}
    }
    return written;
}
export async function checkpointRun<T extends RecordRun>(tx:ISeqFileTransaction,path:string,board:string,value:T):Promise<{value:T;writeCount:number}> {
    const raw=await tx.getEntry(path,runKey(board,value.id));requireValue(raw,'RECORD_EXECUTION_CHECKPOINT_MISSING');
    const previous=JSON.parse(raw) as Hot,{hot,body}=splitRun(value as Saved,previous.ordinal);
    if(['state','code','stage','completion','archivedAt'].every(key=>(previous as any)[key]===(hot as any)[key])&&JSON.stringify(previous.dependencies)===JSON.stringify(hot.dependencies)) {
        const cold=previous.details===hot.details?value:JSON.parse((await tx.getEntry(path,previous.details))!);
        const {details:_details,ordinal:_ordinal,epoch:_epoch,...metadata}=previous;return {value:{...cold,...metadata} as T,writeCount:0};
    }
    requireValue(previous.recordId===hot.recordId&&previous.epoch===hot.epoch&&previous.createdAt===hot.createdAt&&previous.boardId===hot.boardId,'RECORD_RUN_IDENTITY_CHANGED');
    let writeCount=await persistHot(tx,path,board,hot,body,previous);
    if(previous.archivedAt!==hot.archivedAt||hot.updatedAt<previous.updatedAt){
        const related:Hot[]=[];await tx.walkEntries(path,entry=>{related.push(JSON.parse(entry.value));return true;},{keyPrefix:groupPrefix(board,previous)});
        writeCount+=await writeCurrent(tx,path,board,related.map(row=>row.id===hot.id?previous:row),related);
    }else writeCount+=await updateCurrentRun(tx,path,board,hot);
    return {value,writeCount};
}
async function updateCurrentRun(tx:ISeqFileTransaction,path:string,board:string,hot:Hot):Promise<number> {
    let count=0;
    for(const archived of [false,true]){
        if(!archived&&hot.archivedAt!==undefined)continue;
        const key=currentKey(board,hot.recordId,hot.epoch,archived),raw=await tx.getEntry(path,key),old=raw?JSON.parse(raw) as RecordRun:undefined;
        if(!old||old.id===hot.id||hot.createdAt>old.createdAt||hot.createdAt===old.createdAt&&hot.updatedAt>old.updatedAt){
            const value=JSON.stringify(progressValue(hot));if(value!==raw){await tx.setEntry(path,key,value);count++;}
        }
    }return count;
}
export async function readCurrentRuns(reader:Reader,path:string,board:string,records:KanbanRecordSummary[],diagnostic:(event:KanbanRuntimeDiagnostic)=>void):Promise<Map<string,RecordRun>> {
    const started=Date.now(),operationId=randomUUID(),keys=records.filter(row=>row.kind==='decision').map(row=>currentKey(board,row.id,row.executionEpoch,row.archivedAt!==undefined));
    try {
        const values=keys.length?await reader.getEntries(path,keys):{},rows=Object.values(values).map(value=>JSON.parse(value) as RecordRun);
        diagnostic({operationId,boardId:board,stage:'record.progress.storage',result:'success',count:keys.length,readCount:keys.length?1:0,bytes:Object.values(values).reduce((n,value)=>n+new TextEncoder().encode(value).byteLength,0),durationMs:Date.now()-started});
        return new Map(rows.map(row=>[row.recordId,row]));
    }catch(error){diagnostic({operationId,boardId:board,stage:'record.progress.storage',result:'failure',code:safeCode(error,'RECORD_PROGRESS_READ_FAILED'),durationMs:Date.now()-started});throw error;}
}
export async function migrateRunStorage(tx:ISeqFileTransaction,source:string,path:string):Promise<number> {
    if(await tx.getEntry(path,'version')==='1')return 0;
    let count=0;
    await tx.walkEntries(source,async entry=>{
        if(isRunMarker(entry.key,entry.value)){await readRunHistory(tx,path,entry.key,JSON.parse(entry.value).count);return true;}
        const values=JSON.parse(entry.value) as Saved[];
        await writeRunHistory(tx,path,source,entry.key,[],values);count+=values.length;return true;
    },{keyPrefix:family});
    await tx.setEntry(path,'version','1');return count;
}
