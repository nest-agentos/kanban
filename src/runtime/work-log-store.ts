import {FSError, type IFileSystem, type ISeqFileTransaction} from '@nestos/vfs-core';
import type {KanbanProjectRecord, KanbanRecordSummary} from '../contracts';

const snapshotVersion = '2';
const prefix = (board: string) => encodeURIComponent(board) + '/';
const rowKey = (board: string, id: string) => 'row/' + prefix(board) + encodeURIComponent(id);

/** Derived logs have their own append-only storage, outside the decision record limit. */
export class KanbanWorkLogStore {
    private readonly path: string;
    constructor(private readonly fs: IFileSystem, private readonly directory = '/kanban/runtime', private readonly executionSystem = 'kanban-execution') {this.path = directory + '/work-log.seq';}
    async open(): Promise<void> {
        try {await this.fs.driver.createFile({parentPath: this.directory, name: 'work-log.seq', type: 'seqfile', recursive: true});}
        catch (error) {if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error;}
    }
    async record(board: string, id: string): Promise<KanbanProjectRecord | undefined> {
        const raw = await this.fs.meta.seq!.getEntry(this.path, rowKey(board, id)); return raw ? JSON.parse(raw) : undefined;
    }
    async append(board: string, record: KanbanProjectRecord): Promise<void> {
        await this.fs.meta.seq!.transaction!(tx => this.appendTx(tx, board, record));
    }
    async checkpoint(board: string): Promise<number> {return Number(await this.fs.meta.seq!.getEntry(this.path, 'checkpoint/' + prefix(board)) ?? 0);}
    async commit(board: string, after: number, through: number, rows: KanbanProjectRecord[]): Promise<void> {
        await this.fs.meta.seq!.transaction!(async tx => {
            if (Number(await tx.getEntry(this.path, 'checkpoint/' + prefix(board)) ?? 0) !== after) return;
            for (const row of rows) await this.appendTx(tx, board, row);
            await tx.setEntry(this.path, 'checkpoint/' + prefix(board), String(through));
        });
    }
    async needsSnapshot(board: string): Promise<boolean> {return await this.fs.meta.seq!.getEntry(this.path, 'snapshot/' + prefix(board)) !== snapshotVersion;}
    async snapshot(board: string, records: KanbanProjectRecord[]): Promise<void> {
        await this.fs.meta.seq!.transaction!(async tx => {
            const key = 'snapshot/' + prefix(board); if (await tx.getEntry(this.path, key) === snapshotVersion) return;
            for (const record of records) await this.appendTx(tx, board, record);
            await tx.setEntry(this.path, key, snapshotVersion);
        });
    }
    async page(board: string, itemId: string | undefined, offset: number, limit: number) {
        return this.fs.meta.seq!.transaction!(async tx => {
            const rows: KanbanRecordSummary[] = [];
            const keyPrefix = itemId ? 'item/' + prefix(board) + encodeURIComponent(itemId) + '/' : 'summary/' + prefix(board);
            const page = await tx.walkEntries(this.path, entry => {rows.push(JSON.parse(entry.value)); return true;}, {keyPrefix, offset, limit});
            return {items: rows, total: page.total, revision: Number(await tx.getEntry(this.path, 'revision/' + prefix(board)) ?? 0)};
        });
    }
    private async appendTx(tx: ISeqFileTransaction, board: string, row: KanbanProjectRecord): Promise<void> {
        if (await tx.getEntry(this.path, rowKey(board, row.id))) return;
        const {content: _content, rationale: _rationale, sources: _sources, ...metadata} = row;
        const summary: KanbanRecordSummary = {...metadata, sessionIds: row.externalRefs?.filter(ref => ref.system === this.executionSystem).map(ref => ref.id) ?? []};
        const order = String(Number.MAX_SAFE_INTEGER - row.createdAt).padStart(16, '0') + '/' + row.id;
        await tx.setEntry(this.path, rowKey(board, row.id), JSON.stringify(row));
        await tx.setEntry(this.path, 'summary/' + prefix(board) + order, JSON.stringify(summary));
        for (const id of row.itemIds) await tx.setEntry(this.path, 'item/' + prefix(board) + encodeURIComponent(id) + '/' + order, JSON.stringify(summary));
        await tx.increment(this.path, 'revision/' + prefix(board));
    }
}
