import {sha256HexSync} from '../utils';
import type {KanbanAnalysisStatus} from '../contracts';
import type {KanbanAutomationJournal} from './automation-journal';
export interface AnalysisJournalEntry {id:string;itemRevision:number;signature:string;phase:'prepared'|'submitting'|'settled';status:KanbanAnalysisStatus;terminalOutcome?:'succeeded'|'failed'|'cancelled'}
/** Rebuild legacy history once; the hash proves board/item scope even when item IDs overlap. */
export async function analysisHistory<T extends AnalysisJournalEntry = AnalysisJournalEntry>(journal: KanbanAutomationJournal, boardId: string, itemId: string) {
    const key = 'analysis-history:' + JSON.stringify([boardId, itemId]);
    let saved = await journal.get<{keys: string[]; indexed?: boolean}>(key);
    if (!saved?.indexed) {
        const rows = await journal.find<T>('analysis:', (job, entryKey) => job.status?.itemId === itemId
            && entryKey === 'analysis:' + sha256HexSync(JSON.stringify([boardId, itemId, job.itemRevision, job.signature])));
        saved = await journal.update<{keys: string[]; indexed?: boolean}>(key, old =>
            ({keys: [...new Set([...old?.keys ?? [], ...rows.map(row => row.key)])], indexed: true}));
    }
    const jobs = await journal.getMany<T>(saved.keys);
    return jobs.filter((job): job is T => !!job);
}
