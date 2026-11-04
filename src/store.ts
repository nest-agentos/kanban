import {numberEntities, boardCounterKey, boardNumberKey, counter, allocateBoardNumber, patchBoardNumber} from './numbering';
import type { KanbanEvent, KanbanArchivedItem } from './contracts';
import { FSError, type IFileSystem } from '@nestos/vfs-core';
import { KanbanError, type KanbanState, type KanbanStore } from './ports';
import {indexedView, viewFromState, archiveKey, boardKey as key, rowKeys, hydrate, encodeBoard, rowChanges, encodeRow, decodeRow, receiptDigest, verifyReceipt, type StoredBoard, type KanbanBodyStore} from './storage-codec';

/** One user-scoped journal, with atomic board/index/receipt commits. */
export class SeqKanbanStore implements KanbanStore {
    private readonly bodies: KanbanBodyStore;
    private constructor(private readonly fs: IFileSystem, private readonly path: string, bodies?: KanbanBodyStore) {
        this.bodies = bodies ?? {read: async hash => {
            const body = await fs.meta.assets.getAsset(path, `${hash}.json`);
            if (body === null || body instanceof ArrayBuffer) return body;
            throw new KanbanError('BODY_INTEGRITY');
        }, write: async (hash, bytes) => {await fs.meta.assets.putAsset(path, `${hash}.json`, bytes);}};
    }
    static async open(fs: IFileSystem, directory = '/kanban', bodies?: KanbanBodyStore): Promise<SeqKanbanStore> {
        if (!fs.meta.seq?.transaction) throw new KanbanError('TRANSACTION_REQUIRED');
        try { await fs.driver.createFile({ parentPath: directory, name: 'boards.seq', type: 'seqfile', recursive: true }); }
        catch (error) { if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error; }
        return new SeqKanbanStore(fs, `${directory}/boards.seq`, bodies);
    }
    async boardId(number: number): Promise<string | null> {return this.fs.meta.seq!.getEntry(this.path, boardNumberKey(number));}
    async ids(): Promise<string[]> {
        return JSON.parse(await this.fs.meta.seq!.getEntry(this.path, 'index') ?? '[]');
    }
    async events(id: string, after: number, limit: number, through: number): Promise<KanbanEvent[]> {
        const end = Math.min(through, after + limit);
        const keys = Array.from({length: Math.max(0, end - after)}, (_, index) =>
            `event/${encodeURIComponent(id)}/${String(after + index + 1).padStart(16, '0')}`);
        if (!keys.length) return [];
        // The committed sequence freezes this immutable prefix; bulk key reads avoid history scans.
        const rows = await this.fs.meta.seq!.getEntries(this.path, keys);
        return keys.filter(key => rows[key] !== undefined).map(key => JSON.parse(rows[key]) as KanbanEvent);
    }

    async archived(boardId: string, itemId: string): Promise<KanbanArchivedItem | null> {
        const raw = await this.fs.meta.seq!.getEntry(this.path, archiveKey(boardId, itemId));
        if (!raw) return null; const record = await decodeRow<KanbanArchivedItem>(raw, this.bodies);
        record.item.number ??= (await this.view(boardId))?.state.archiveIndex?.find(item => item.id === itemId)?.number; return record;
    }
    private async load(id: string, receiptKey?: string): Promise<StoredBoard & {receipt?: string | null}> {
        return this.fs.meta.seq!.transaction!(async tx => {
            const raw = await tx.getEntry(this.path, key(id));
            return {raw, rows: await tx.getEntries(this.path, rowKeys(raw)), receipt: receiptKey ? await tx.getEntry(this.path, receiptKey) : undefined};
        });
    }
    async view(id: string) {
        const raw = await this.fs.meta.seq!.getEntry(this.path, key(id));
        const indexed = indexedView(raw); if (indexed) return indexed;
        const state = await this.read(id); return state ? viewFromState(state) : null;
    }
    async read(id: string): Promise<KanbanState | null> {return hydrate(await this.load(id), this.bodies);}
    async update(id: string, operationId: string, fingerprint: string,
        change: (state: KanbanState | null) => KanbanState): Promise<KanbanState> {
        const receiptKey = `receipt/${encodeURIComponent(id)}/${encodeURIComponent(operationId)}`;
        const before = await this.load(id, receiptKey), current = await hydrate(before, this.bodies), receipt = before.receipt;
        if (receipt) {verifyReceipt(receipt, fingerprint); if (!current) throw new KanbanError('CORRUPT_RECEIPT'); return current;}
        const original = JSON.stringify(current), next = change(current);
        numberEntities(next);
        if (JSON.stringify(next) === original) return next;
        return this.persist(id, receiptKey, fingerprint, before, next);
    }
    private async persist(id: string, receiptKey: string, fingerprint: string, before: StoredBoard, next: KanbanState): Promise<KanbanState> {
        const events = [...next.events], archives = await Promise.all((next.archiveWrites ?? []).map(async write =>
            ({key: archiveKey(id, write.id), value: write.value ? await encodeRow(write.value, this.bodies) : null})));
        delete next.archiveWrites; next.events = [];
        // No asset I/O runs under the SeqFile transaction: it may use the same backend.
        const encoded = await encodeBoard(next, this.bodies);
        const committed = await this.fs.meta.seq!.transaction!(async tx => {
            const latestReceipt = await tx.getEntry(this.path, receiptKey);
            if (latestReceipt) {verifyReceipt(latestReceipt, fingerprint); return null;}
            if (await tx.getEntry(this.path, key(id)) !== before.raw) throw new KanbanError('REVISION_CONFLICT');
            await commitBoardNumber(tx, this.path, id, before, next, encoded);
            const eventRows = events.map(event => ({key: `event/${encodeURIComponent(id)}/${String(event.sequence).padStart(16, '0')}`, value: JSON.stringify(event)}));
            await writeRows(tx, this.path, [...eventRows, ...rowChanges(before, encoded), ...archives,
                {key: key(id), value: encoded.raw!}, {key: receiptKey, value: receiptDigest(fingerprint)}]);
            const ids: string[] = JSON.parse(await tx.getEntry(this.path, 'index') ?? '[]');
            if (!ids.includes(id)) await tx.setEntry(this.path, 'index', JSON.stringify([...ids, id]));
            return next;
        });
        if (committed) return committed;
        const replay = await this.read(id); if (!replay) throw new KanbanError('CORRUPT_RECEIPT'); return replay;
    }
}
async function writeRows(tx: import('@nestos/vfs-core').ISeqFileTransaction, path: string, rows: Array<{key: string; value: string | null}>): Promise<void> {
    for (const row of rows) {
        if (row.value === null) await tx.deleteEntry(path, row.key);
        else await tx.setEntry(path, row.key, row.value);
    }
}

async function commitBoardNumber(tx: import('@nestos/vfs-core').ISeqFileTransaction, path: string, id: string, before: StoredBoard, next: KanbanState, encoded: StoredBoard): Promise<void> {
    const previous = counter(await tx.getEntry(path, boardCounterKey));
    next.board.number = allocateBoardNumber(before.raw, previous);
    const owner = await tx.getEntry(path, boardNumberKey(next.board.number));
    if (owner !== null && owner !== id) throw new KanbanError('INVALID_NUMBERING');
    encoded.raw = patchBoardNumber(encoded.raw!, next.board.number);
    await tx.setEntry(path, boardCounterKey, String(Math.max(previous, next.board.number)));
    await tx.setEntry(path, boardNumberKey(next.board.number), id);
}
