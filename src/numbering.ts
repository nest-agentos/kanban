import type {KanbanState} from './ports';
import {requireValue} from './rules';

export const boardCounterKey = 'counter/board';
export const boardNumberKey = (number: number): string => `reference/board/${number}`;
export function counter(raw: string | null): number {
    requireValue(raw === null || /^(0|[1-9]\d*)$/.test(raw), 'INVALID_NUMBER_COUNTER');
    const value = raw === null ? 0 : Number(raw);
    requireValue(Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER, 'INVALID_NUMBER_COUNTER'); return value;
}
export function storedBoardNumber(raw: string | null): number | undefined {
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw), number = (parsed.layout === 2 ? parsed.state?.board : parsed.board)?.number;
    if (number !== undefined) requireValue(Number.isSafeInteger(number) && number > 0, 'INVALID_NUMBERING'); return number;
}
export function patchBoardNumber(raw: string, number: number): string {
    const parsed = JSON.parse(raw); parsed.state.board.number = number; return JSON.stringify(parsed);
}
/** Counters and identities live in the board commit, including drafts and archived items. */
export function numberEntities(state: KanbanState): void {
    const high = state.numbering ??= {item: 0, log: 0, decision: 0};
    const items = [...state.board.items, ...(state.archiveIndex ?? []), ...(state.archiveWrites ?? []).flatMap(write => write.value ? [write.value.item] : [])];
    high.item = assign(items, high.item);
    for (const kind of ['log', 'decision'] as const) high[kind] = assign((state.records ?? []).filter(record => record.kind === kind), high[kind]);
}
function assign(rows: Array<{id: string; number?: number}>, high: number): number {
    counter(String(high)); const used = new Map<number, string>(), known = new Map<string, number>();
    for (const row of rows) if (row.number !== undefined) {
        requireValue(Number.isSafeInteger(row.number) && row.number > 0 && (!used.has(row.number) || used.get(row.number) === row.id)
            && (!known.has(row.id) || known.get(row.id) === row.number), 'INVALID_NUMBERING');
        used.set(row.number, row.id); known.set(row.id, row.number); high = Math.max(high, row.number);
    }
    for (const row of rows) if (row.number === undefined) {
        if (!known.has(row.id)) {requireValue(high < Number.MAX_SAFE_INTEGER, 'NUMBER_COUNTER_EXHAUSTED'); known.set(row.id, ++high);}
        row.number = known.get(row.id)!;
    }
    return high;
}

export function allocateBoardNumber(raw: string | null, high: number): number {
    const known = storedBoardNumber(raw); if (known !== undefined) return known;
    requireValue(high < Number.MAX_SAFE_INTEGER, 'NUMBER_COUNTER_EXHAUSTED'); return high + 1;
}

/** Allocate within the board transaction, including retained and archived identities. */
export function allocateTaskId(state: KanbanState): string {
    const taken = new Set([...state.board.items, ...state.archiveIndex ?? []].map(item => item.id));
    let number = state.numbering!.item, id: string;
    do {
        requireValue(number < Number.MAX_SAFE_INTEGER, 'NUMBER_COUNTER_EXHAUSTED');
        id = 'task-' + String(++number).padStart(3, '0');
    } while (taken.has(id));
    state.numbering!.item = number - 1;
    return id;
}
