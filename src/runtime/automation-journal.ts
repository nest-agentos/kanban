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
    private readonly artifactScheme: string;
    constructor(private readonly fs: IFileSystem, private readonly options: KanbanJournalOptions = {}) {
        this.directory = normalizeVirtualPath(options.directory ?? '/kanban/runtime');
        this.path = this.directory + '/automation.seq'; this.indexPath = this.directory + '/automation-board-index.seq';
        this.artifactScheme = options.artifactScheme ?? 'kanban-artifact:';
    }
    diagnostic(event: KanbanRuntimeDiagnostic): void {this.options.diagnostic?.(event);}
    async open(): Promise<void> {
        requireValue(this.fs.meta.seq?.transaction, 'TRANSACTION_REQUIRED');
        for (const name of ['automation.seq', 'automation-board-index.seq']) {
            try {await this.fs.driver.createFile({parentPath: this.directory, name, type: 'seqfile', recursive: true});}
            catch (error) {if ((error as {code?: string}).code !== 'EEXIST') throw error;}
        }
        if (await this.fs.meta.seq!.getEntry(this.indexPath, 'version') !== '1')
            await this.fs.meta.seq!.transaction!(tx => migrateBoardIndex(tx, this.path, this.indexPath, event => this.diagnostic(event)));
    }
    async get<T>(key: string): Promise<T | undefined> {
        const raw = await this.fs.meta.seq!.getEntry(this.path, key); return raw ? JSON.parse(raw) as T : undefined;
    }
    async getMany<T>(keys: string[]): Promise<Array<T | undefined>> {
        if (!keys.length) return [];
        const rows = await this.fs.meta.seq!.getEntries(this.path, keys);
        return keys.map(key => rows[key] === undefined ? undefined : JSON.parse(rows[key]) as T);
    }
    async findForBoard<T>(family: string, boardId: string, matches: (value: T) => boolean): Promise<Array<{key: string; value: T}>> {
        const keys: string[] = [];
        await this.fs.meta.seq!.walkEntries(this.indexPath, entry => {
            keys.push(entry.value); requireValue(keys.length <= 1000, 'SESSION_RELATION_LIMIT'); return true;
        }, {keyPrefix: boardIndexPrefix(boardId, family)});
        const values = await this.getMany<T>(keys);
        return values.flatMap((value, index) => value !== undefined && matches(value) ? [{key: keys[index], value}] : []);
    }
    async find<T>(keyPrefix: string, matches: (value: T, key: string) => boolean): Promise<Array<{key: string; value: T}>> {
        const rows: Array<{key: string; value: T}> = [];
        await this.fs.meta.seq!.walkEntries(this.path, entry => {
            const value = JSON.parse(entry.value) as T;
            if (matches(value, entry.key)) rows.push({key: entry.key, value});
            requireValue(rows.length <= 1000, 'SESSION_RELATION_LIMIT'); return true;
        }, {keyPrefix});
        return rows;
    }
    update<T>(key: string, change: (previous: T | undefined) => T): Promise<T> {
        const pending = this.commit(key, change).finally(() => {this.writes.delete(pending);});
        this.writes.add(pending); return pending;
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
            const raw = await tx.getEntry(this.path, key), previous = raw ? JSON.parse(raw) as T : undefined;
            const previousIndex = boardIndexKeys(key, previous), value = change(previous);
            const encoded = JSON.stringify(value);
            if (encoded === raw) return structuredClone(value);
            await updateBoardIndex(tx, key, previousIndex, value, this.indexPath);
            await tx.setEntry(this.path, key, encoded); return structuredClone(value);
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
