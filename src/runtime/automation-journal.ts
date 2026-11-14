import {randomUUID} from '../utils';
import {safeCode} from './diagnostics';
import type {RecordRun} from './record-progress-groups';
import {activeRunHistory,readRun,runSummaries,checkpointRun,isRunMarker,readRunHistory,writeRunHistory,readCurrentRuns,migrateRunStorage} from './record-run-storage';
import type {ISeqFileTransaction} from '@nestos/vfs-core';
import type {KanbanRecordSummary} from '../contracts';
import {normalizeVirtualPath, type IFileSystem} from '@nestos/vfs-core';
import type {KanbanJournalOptions, KanbanRuntimeDiagnostic} from './ports';
import {sha256HexSync} from '../utils';
import type {KanbanArtifactRef} from '../contracts';
import {requireValue} from '../rules';

import {boardIndexPrefix, boardIndexKeys, migrateBoardIndex, updateBoardIndex} from './automation-board-index';

export class KanbanAutomationJournal {
    private readonly writes = new Set<Promise<unknown>>();
    readonly directory: string;
    readonly indexPath: string;
    private readonly path: string;
    private readonly runsPath:string;
    private readonly artifactScheme: string;
    constructor(private readonly fs: IFileSystem, private readonly options: KanbanJournalOptions = {}) {
        this.directory = normalizeVirtualPath(options.directory ?? '/kanban/runtime');
        this.runsPath=this.directory+'/record-runs.seq';
        this.path = this.directory + '/automation.seq'; this.indexPath = this.directory + '/automation-board-index.seq';
        this.artifactScheme = options.artifactScheme ?? 'kanban-artifact:';
    }
    diagnostic(event: KanbanRuntimeDiagnostic): void {this.options.diagnostic?.(event);}
    async open(): Promise<void> {
        requireValue(this.fs.meta.seq?.transaction, 'TRANSACTION_REQUIRED');
        for (const name of ['automation.seq', 'automation-board-index.seq','record-runs.seq']) {
            try {await this.fs.driver.createFile({parentPath: this.directory, name, type: 'seqfile', recursive: true});}
            catch (error) {if ((error as {code?: string}).code !== 'EEXIST') throw error;}
        }
        if (await this.fs.meta.seq!.getEntry(this.indexPath, 'version') !== '1')
            await this.fs.meta.seq!.transaction!(tx => migrateBoardIndex(tx, this.path, this.indexPath, event => this.diagnostic(event),(key,raw)=>this.decode(key,raw,tx)));
        if(await this.fs.meta.seq!.getEntry(this.runsPath,'version')!=='1')
            await this.migrateRuns();
    }
    private async migrateRuns():Promise<void> {
        const started=Date.now(),operationId=randomUUID();
        try {
            const count=await this.fs.meta.seq!.transaction!(tx=>migrateRunStorage(tx,this.path,this.runsPath));
            this.diagnostic({operationId,stage:'record.runs.migrate',result:'success',count,durationMs:Date.now()-started});
        }catch(error){this.diagnostic({operationId,stage:'record.runs.migrate',result:'failure',code:safeCode(error,'RECORD_RUN_MIGRATION_FAILED'),durationMs:Date.now()-started});throw error;}
    }
    currentRuns(board:string,records:KanbanRecordSummary[]) {
        return readCurrentRuns(this.fs.meta.seq!,this.runsPath,board,records,event=>this.diagnostic(event));
    }
    runSummaries(board:string,recordId?:string) {return runSummaries(this.fs.meta.seq!,this.runsPath,board,recordId);}
    activeRuns<T>(board:string):Promise<T[]> {return activeRunHistory(this.fs.meta.seq!,this.runsPath,board);}
    run<T>(board:string,id:string):Promise<T|undefined> {return readRun(this.fs.meta.seq!,this.runsPath,board,id);}
    saveRun<T extends RecordRun>(board:string,value:T):Promise<T> {
        const operationId=randomUUID(),started=Date.now();
        const work=this.fs.meta.seq!.transaction!(tx=>checkpointRun(tx,this.runsPath,board,value)).then(result=>{
            this.diagnostic({operationId,boardId:board,stage:'record.runs.checkpoint',result:'success',count:1,writeCount:result.writeCount,durationMs:Date.now()-started});return result.value;
        }).catch(error=>{this.diagnostic({operationId,boardId:board,stage:'record.runs.checkpoint',result:'failure',code:safeCode(error,'RECORD_RUN_CHECKPOINT_FAILED'),durationMs:Date.now()-started});throw error;}).finally(()=>{this.writes.delete(work);});
        this.writes.add(work);return work;
    }
    private async decode<T>(key:string,raw:string|null,tx?:ISeqFileTransaction):Promise<T|undefined> {
        if(raw===null)return;
        return (isRunMarker(key,raw)?await readRunHistory(tx??this.fs.meta.seq!,this.runsPath,key,JSON.parse(raw).count):JSON.parse(raw)) as T;
    }
    private async write(tx:ISeqFileTransaction,key:string,previous:unknown,value:unknown,encoded:string):Promise<void> {
        await updateBoardIndex(tx,key,boardIndexKeys(key,previous),value,this.indexPath);
        if(key.startsWith('record-runs:'))await writeRunHistory(tx,this.runsPath,this.path,key,(previous??[]) as never,value as never);
        else await tx.setEntry(this.path,key,encoded);
    }
    async get<T>(key: string): Promise<T | undefined> {
        const raw = await this.fs.meta.seq!.getEntry(this.path, key); return this.decode<T>(key,raw);
    }
    async getMany<T>(keys: string[]): Promise<Array<T | undefined>> {
        if (!keys.length) return [];
        const rows = await this.fs.meta.seq!.getEntries(this.path, keys);
        return Promise.all(keys.map(key=>this.decode<T>(key,rows[key]??null)));
    }
    async findForBoard<T>(family: string, boardId: string, matches: (value: T) => boolean): Promise<Array<{key: string; value: T}>> {
        const keys: string[] = [];
        await this.fs.meta.seq!.walkEntries(this.indexPath, entry => {
            keys.push(entry.value); requireValue(keys.length <= 1000, 'SESSION_RELATION_LIMIT'); return true;
        }, {keyPrefix: boardIndexPrefix(boardId, family)});
        const values = await this.getMany<T>(keys);
        return values.flatMap((value, index) => value !== undefined && matches(value) ? [{key: keys[index], value}] : []);
    }
    async find<T>(keyPrefix:string,matches:(value:T,key:string)=>boolean):Promise<Array<{key:string;value:T}>> {
        const saved:Array<{key:string;raw:string}>=[];
        await this.fs.meta.seq!.walkEntries(this.path,entry=>{saved.push({key:entry.key,raw:entry.value});return true;},{keyPrefix});
        const rows=await Promise.all(saved.map(async row=>({key:row.key,value:(await this.decode<T>(row.key,row.raw))!})));
        const result=rows.filter(row=>matches(row.value,row.key));requireValue(result.length<=1000,'SESSION_RELATION_LIMIT');return result;
    }
    update<T>(key: string, change: (previous: T | undefined) => T): Promise<T> {
        const pending = this.commit(key, change).finally(() => {this.writes.delete(pending);});
        this.writes.add(pending); return pending;
    }
    /** Commit related checkpoints together; callbacks are synchronous and cannot perform I/O. */
    updateMany(changes:Array<{key:string;change(previous:unknown):unknown}>):Promise<void> {
        requireValue(changes.length<=128&&new Set(changes.map(row=>row.key)).size===changes.length,'INVALID_JOURNAL_BATCH');
        const pending=this.fs.meta.seq!.transaction!(async tx=>{
            for(const {key,change}of changes){
                const raw=await tx.getEntry(this.path,key),previous=await this.decode(key,raw,tx),value=change(previous),encoded=JSON.stringify(value);
                requireValue(encoded!==undefined,'INVALID_JOURNAL_VALUE');
                if(JSON.stringify(previous)===encoded)continue;
                await this.write(tx,key,previous,value,encoded);
            }
        }).finally(()=>{this.writes.delete(pending);});
        this.writes.add(pending);return pending;
    }
    async drain(): Promise<void> {await Promise.allSettled([...this.writes]);}
    claim(key: string): Promise<boolean> {
        const pending = this.fs.meta.seq!.transaction!(async tx => {
            const raw = await tx.getEntry(this.path, key); requireValue(raw, 'AUTOMATION_JOURNAL_MISSING');
            const record = JSON.parse(raw) as {phase: string};
            if (record.phase !== 'prepared') return false;
            await tx.setEntry(this.path, key, JSON.stringify({...record, phase: 'submitting'})); return true;
        }).finally(() => {this.writes.delete(pending);});
        this.writes.add(pending); return pending;
    }
    private async commit<T>(key: string, change: (previous: T | undefined) => T): Promise<T> {
        return this.fs.meta.seq!.transaction!(async tx => {
            const raw = await tx.getEntry(this.path, key), previous = await this.decode<T>(key,raw,tx);
            const value = change(previous);
            const encoded = JSON.stringify(value);
            if (encoded === JSON.stringify(previous)) return structuredClone(value);
            await this.write(tx,key,previous,value,encoded!); return structuredClone(value);
        });
    }
    async artifact(dispatchId: string, value: unknown): Promise<KanbanArtifactRef[]> {
        const text = JSON.stringify(value ?? null), bytes = new TextEncoder().encode(text).byteLength;
        requireValue(bytes <= 1024 * 1024, 'AUTOMATION_OUTPUT_TOO_LARGE');
        const sha256 = sha256HexSync(text);
        await this.update<string>('artifact:' + sha256, previous => {requireValue(previous === undefined || previous === text, 'ARTIFACT_CONFLICT'); return text;});
        const outputs = [{name: 'result', ref: this.artifactScheme + sha256, sha256, bytes}];
        await this.update<KanbanArtifactRef[]>('artifact-owner:' + dispatchId, previous => {
            requireValue(!previous || JSON.stringify(previous) === JSON.stringify(outputs), 'ARTIFACT_CONFLICT'); return outputs;
        });
        return outputs;
    }
    async verify(outputs: KanbanArtifactRef[], dispatchId?: string): Promise<boolean> {
        if (dispatchId && JSON.stringify(await this.get('artifact-owner:' + dispatchId)) !== JSON.stringify(outputs)) return false;
        for (const output of outputs) {
            if (output.ref !== this.artifactScheme + output.sha256) return false;
            const text = await this.get<string>('artifact:' + output.sha256);
            if (text === undefined || sha256HexSync(text) !== output.sha256 || new TextEncoder().encode(text).byteLength !== output.bytes) return false;
        }
        return true;
    }
}
