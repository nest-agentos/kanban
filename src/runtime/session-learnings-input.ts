import {KanbanError} from '../ports';
const failure=(code:string)=>new KanbanError(code);

interface Learning {
    id: string; itemId: string; event: string; handling: string; reason: string;
    result: string; conditions: string; evidence: string[];
}

/** Keep summaries bounded and strip common credential forms before durable commands. */
export function learningText(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 1200) throw failure('LEARNING_TEXT_INVALID');
    return value.trim()
        .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted]')
        .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, '[redacted]')
        .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/g, '[redacted]')
        .replace(/((?:api[_-]?key|password|passwd|secret|token|authorization)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
        .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@[^\s]+/gi, '[redacted]')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]');
}

export function parseSessionLearnings(payload: unknown): Learning[] {
    const value = (payload as {learnings?: unknown} | null)?.learnings;
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 8) throw failure('LEARNING_LIMIT');
    const rows = value.map(parseLearning);
    if (new Set(rows.map(row => JSON.stringify([row.itemId, row.id]))).size !== rows.length) throw failure('LEARNING_DUPLICATE_ID');
    return rows;
}

function parseLearning(value: unknown): Learning {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('LEARNING_INVALID');
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some(key => !['id', 'itemId', 'event', 'handling', 'reason', 'result', 'conditions', 'evidence'].includes(key))) throw failure('LEARNING_FIELD_INVALID');
    if (typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(row.id)
        || typeof row.itemId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.itemId)) throw failure('LEARNING_ID_INVALID');
    const evidence = row.evidence ?? [];
    if (!Array.isArray(evidence) || evidence.length > 4 || evidence.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))) throw failure('LEARNING_EVIDENCE_INVALID');
    return {id: row.id, itemId: row.itemId, event: learningText(row.event), handling: learningText(row.handling),
        reason: learningText(row.reason), result: learningText(row.result), conditions: learningText(row.conditions), evidence};
}
