import {discoveryState} from './discovery-state';
import {randomUUID} from './utils';
import type {KanbanDiscoveryChange, KanbanRequest, KanbanScanInput, KanbanScanSession, KanbanScanText} from './contracts';
import {KanbanError, KanbanScanNotStartedError} from './ports';
import type {KanbanDiscoveryOptions, KanbanDiscoveryState} from './scan-ports';
import {scanContext} from './scan-context';
import {identity, positive, requireValue, text as validateText} from './rules';

export interface KanbanDiscoveryHandle {scan(): Promise<void>; tick(): Promise<void>; reset(runId: string): Promise<void>; quiesce(): Promise<void>; dispose(): Promise<void>}
export function createKanbanDiscovery(options: KanbanDiscoveryOptions): KanbanDiscoveryHandle {return new Discovery(options);}
class Discovery {
    private readonly now;
    private readonly id;
    private readonly token;
    private active?: Promise<void>;
    private stopping = false;
    private readonly resets = new Set<Promise<void>>();
    private stage = 'prepare';
    constructor(private readonly options: KanbanDiscoveryOptions) {
        this.now = options.now ?? Date.now; this.id = options.id ?? randomUUID; this.token = this.id();
        for (const value of [options.policy.idleMs, options.policy.maxSessions, options.policy.maxInputBytes, options.policy.leaseMs]) positive(value);
        identity(options.policy.connection.connectionId);
    }
    scan = (): Promise<void> => {
        if (this.stopping) return Promise.reject(new KanbanError('SERVICE_STOPPING'));
        if (this.active) return this.active;
        const operationId = this.id(), started = this.now();
        this.active = this.run().catch(async error => {
            if (error instanceof KanbanError && ['SOURCE_CHANGED', 'SCAN_BOARD_CHANGED', 'REVISION_CONFLICT'].includes(error.code)) {
                await this.settleInvalidatedRun();
                await this.update('invalidate', state => {if (state.pending?.token === this.token) {
                    state.lastRun = {runId: state.pending.runId, outcome: 'invalidated', at: this.now(), code: error.code}; delete state.pending;
                }});
            }
            throw error;
        }).then(() => this.log(operationId, started, 'success'), error => {
            this.log(operationId, started, 'failure', errorCode(error)); throw error;
        }).finally(() => {this.active = undefined;});
        return this.active;
    };
    tick = (): Promise<void> => this.scan();
    async quiesce(): Promise<void> {
        this.stopping = true;
        await Promise.allSettled([this.active, ...this.resets]);
    }
    dispose = (): Promise<void> => this.quiesce();
    reset = (runId: string): Promise<void> => {
        if (this.stopping) return Promise.reject(new KanbanError('SERVICE_STOPPING'));
        const work = this.resetRun(runId).finally(() => {this.resets.delete(work);});
        this.resets.add(work); return work;
    };
    private async resetRun(runId: string): Promise<void> {
        const pending = discoveryState(await this.options.store.read(this.options.boardId))?.pending;
        requireValue(pending?.runId === runId, 'SCAN_CHANGED');
        await this.options.authorize('commit', pending.input);
        requireValue(pending.token === this.token || pending.leaseUntil <= this.now(), 'SCAN_BUSY');
        if (pending.executionStarted && !pending.executionSettled) requireValue(await this.options.executor.settled?.(pending.input), 'SCAN_EXECUTION_UNSETTLED');
        await this.update('reset', state => {
            requireValue(state.pending?.runId === runId && state.pending.token === pending.token, 'SCAN_CHANGED');
            state.lastRun = {runId, outcome: 'invalidated', at: this.now(), code: 'SCAN_MANUAL_RESET'}; delete state.pending;
        });
    }
    private async run(): Promise<void> {
        await this.options.authorize('read');
        const board = await this.options.service.read(this.options.boardId);
        requireValue(matchesScope(board.scope, this.options.source), 'SOURCE_PROJECT_MISMATCH');
        requireValue(this.options.source.kind === this.options.policy.connection.kind || this.options.policy.connection.allowContentTransfer, 'CONTENT_TRANSFER_NOT_ALLOWED');
        const stored = await this.options.store.read(board.id);
        let pending = discoveryState(stored)?.pending;
        if (pending && pending.token !== this.token && pending.leaseUntil > this.now()) return;
        if (!pending) {
            const sessions = await this.collect(); if (!sessions.length) return;
            const current = await this.options.store.read(board.id); requireValue(current, 'BOARD_NOT_FOUND');
            const input = scanContext(board, current, sessions, this.options, this.id());
            requireValue(new TextEncoder().encode(JSON.stringify(input)).length <= this.options.policy.maxInputBytes, 'SCAN_INPUT_LIMIT');
            pending = {runId: input.runId, autoCreate: this.options.policy.autoCreate && (input.projectContext?.omittedRecords ?? 0) === 0 && input.context!.omittedItems === 0 && input.context!.archivedItems.length === input.context!.archivedTotal, token: this.token, leaseUntil: this.now() + this.options.policy.leaseMs, input};
        }
        const selected = pending;
        await this.update('claim', state => {
            requireValue(!state.pending || state.pending.token === this.token || state.pending.leaseUntil <= this.now(), 'SCAN_BUSY');
            if (state.pending) requireValue(state.pending.runId === selected.runId, 'SCAN_CHANGED');
            const restoring = selected.token !== this.token;
            state.pending = {...selected, ...(restoring ? {request: undefined} : {}), token: this.token, leaseUntil: this.now() + this.options.policy.leaseMs};
        });
        await this.process();
    }
    private async collect(): Promise<KanbanScanText[]> {
        this.stage = 'source.list';
        const sessions = await this.options.source.list(this.options.policy.includeArchived);
        for (const session of sessions) {
            identity(session.id); requireValue(typeof session.revision === 'string' && session.revision.length > 0 && session.revision.length <= 16000, 'INVALID_SOURCE_REVISION');
        }
        requireValue(new Set(sessions.map(s => s.id)).size === sessions.length, 'DUPLICATE_SOURCE_SESSION');
        await this.observe(sessions);
        const state = discoveryState(await this.options.store.read(this.options.boardId))!;
        const result: KanbanScanText[] = []; let bytes = 0;
        for (const session of sessions.sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0) || a.id.localeCompare(b.id))) {
            if (!this.eligible(session, state)) continue;
            const current = await this.options.source.inspect(session.id);
            if (!this.eligible(current, state) || current.revision !== session.revision) continue;
            this.stage = 'source.read';
            const text = await this.readCandidate(current, Math.floor(this.options.policy.maxInputBytes * 0.7) - bytes);
            if (!text) continue;
            requireValue(text.session.id === current.id && text.session.revision === current.revision, 'SOURCE_CHANGED');
            if (!text.complete) continue;
            const size = new TextEncoder().encode(JSON.stringify(text)).length;
            if (bytes + size > this.options.policy.maxInputBytes * 0.7) break;
            bytes += size; result.push(text); if (result.length >= this.options.policy.maxSessions) break;
        }
        return result;
    }
    private async readCandidate(session: KanbanScanSession, maxBytes: number): Promise<KanbanScanText | null> {
        const started = this.now();
        try {
            const result = await this.options.source.read(session, maxBytes);
            if (!result.complete) this.log(this.id(), started, 'failure', 'SOURCE_PROVENANCE_UNKNOWN', session.id);
            return result;
        } catch (error) {
            const code = errorCode(error);
            if (!['SCAN_INPUT_LIMIT', 'SOURCE_CHANGED', 'HARNESS_DIGEST_CHANGED'].includes(code)) throw error;
            this.log(this.id(), started, 'failure', code, session.id); return null;
        }
    }
    private eligible(session: KanbanScanSession, state: KanbanDiscoveryState): boolean {
        const quiet = state.observations?.[session.id];
        return !session.scannerOwned && (this.options.policy.includeArchived || !session.archived)
            && session.activity === 'idle' && session.updatedAt !== null && session.updatedAt <= this.now()
            && quiet?.revision === session.revision && this.now() - quiet.idleSince >= this.options.policy.idleMs
            && state.checkpoints[session.id] !== session.revision;
    }
    private async observe(sessions: KanbanScanSession[]): Promise<void> {
        await this.update('observe', state => {
            state.observations ??= {};
            for (const session of sessions) {
                if (session.activity !== 'idle' || session.scannerOwned) {delete state.observations[session.id]; continue;}
                const old = state.observations[session.id];
                if (old?.revision !== session.revision) state.observations[session.id] = {revision: session.revision, idleSince: this.now()};
            }
        });
    }
    private async process(): Promise<void> {
        let pending = discoveryState(await this.options.store.read(this.options.boardId))!.pending!;
        requireValue(pending.input.executorId === this.options.executor.identity, 'SCANNER_EXECUTOR_CHANGED');
        await this.checkSources(pending.input);
        if (!pending.changes) {
            await this.options.authorize('execute', pending.input);
            this.stage = 'analyzer.execute';
            await this.updateOwned('execute', state => {state.pending!.executionStarted = true;});
            const output = await this.execute(pending.input), result = Array.isArray(output) ? {changes: output} : output;
            await this.updateOwned('settled', state => {state.pending!.executionSettled = true;});
            validateChanges(result.changes, pending.input); validateRecords(result.records ?? [], pending.input, result.changes);
            await this.updateOwned('result', state => {state.pending!.changes = result.changes; state.pending!.records = result.records;});
        }
        pending = discoveryState(await this.options.store.read(this.options.boardId))!.pending!;
        await this.options.authorize('commit', pending.input); await this.checkSources(pending.input);
        if (!pending.request) {
            const board = await this.options.service.read(this.options.boardId);
            requireValue(board.revision === pending.input.board.revision, 'SCAN_BOARD_CHANGED');
            const request: KanbanRequest = {operationId: `discovery:${pending.runId}`, expectedRevision: board.revision,
                command: {type: 'apply-discovery', batch: {runId: pending.runId, leaseToken: this.token, changes: pending.changes!, ...(pending.records ? {records: pending.records} : {}), autoCreate: pending.autoCreate,
                    checkpoints: pending.input.sessions.map(s => ({sessionId: s.session.id, revision: s.session.revision}))}}};
            await this.updateOwned('prepare', state => {state.pending!.request = request;});
            pending.request = request;
        }
        this.stage = 'board.commit';
        await this.options.service.execute(this.options.boardId, pending.request);
    }
    private async execute(input: KanbanScanInput): Promise<KanbanDiscoveryChange[] | import('./contracts').KanbanDiscoveryResult> {
        try {return await this.options.executor.run(structuredClone(input));}
        catch (error) {
            if (error instanceof KanbanScanNotStartedError) await this.updateOwned('not-started', state => {state.pending!.executionSettled = true;});
            throw error;
        }
    }
    private async settleInvalidatedRun(): Promise<void> {
        const pending = discoveryState(await this.options.store.read(this.options.boardId))?.pending;
        if (!pending || pending.token !== this.token || !pending.executionStarted || pending.executionSettled) return;
        requireValue(await this.options.executor.settled?.(pending.input), 'SCAN_EXECUTION_UNSETTLED');
    }
    private async checkSources(input: KanbanScanInput): Promise<void> {
        for (const source of input.sessions) {
            const current = await this.options.source.inspect(source.session.id);
            requireValue(current.revision === source.session.revision && current.activity === 'idle' && !current.scannerOwned, 'SOURCE_CHANGED');
        }
    }
    private async updateOwned(stage: string, mutate: (state: KanbanDiscoveryState) => void): Promise<void> {
        await this.update(stage, state => {
            requireValue(state.pending?.token === this.token && state.pending.leaseUntil > this.now(), 'SCAN_LEASE_EXPIRED'); mutate(state);
        });
    }
    private async update(stage: string, mutate: (state: KanbanDiscoveryState) => void): Promise<void> {
        const operation = this.id();
        await this.options.store.update(this.options.boardId, operation, `discovery:${stage}:${operation}`, state => {
            requireValue(state, 'BOARD_NOT_FOUND'); state.discovery ??= {checkpoints: {}}; mutate(state.discovery as KanbanDiscoveryState); return state;
        });
    }
    private log(operationId: string, started: number, result: 'success' | 'failure', code?: string, sessionId?: string): void {
        try {this.options.log({operationId, boardId: this.options.boardId, sessionId, stage: `discovery.${this.stage}`, result, code, durationMs: this.now() - started});}
        catch { /* Diagnostics cannot affect durable execution. */ }
    }
}
function validateChanges(changes: KanbanDiscoveryChange[], input: KanbanScanInput): void {
    requireValue(Array.isArray(changes) && changes.length <= 50, 'SCAN_CHANGE_LIMIT');
    const ids = new Set<string>();
    for (const change of changes) {
        requireValue(change && ['create', 'update', 'link'].includes(change.action) && !ids.has(change.itemId), 'INVALID_CHANGE'); ids.add(change.itemId); identity(change.itemId);
        if (change.action !== 'create') requireValue(input.board.items.some(i => i.id === change.itemId), 'UNKNOWN_CONTEXT_ITEM');
        validateText(change.title); validateText(change.responsibility); validateText(change.acceptance);
        requireValue(change.eligibleAgentIds === undefined || Array.isArray(change.eligibleAgentIds), 'INVALID_ELIGIBILITY');
        change.eligibleAgentIds?.forEach(identity);
        requireValue(change.eligiblePrincipals === undefined || Array.isArray(change.eligiblePrincipals), 'INVALID_ELIGIBILITY');
        requireValue(Array.isArray(change.sources) && change.sources.length > 0 && change.sources.length <= 100 && change.sources.some(s => s.role === 'user'), 'USER_EVIDENCE_REQUIRED');
        for (const ref of change.sources) {
            const source = input.sessions.find(s => s.session.id === ref.sessionId && s.session.revision === ref.revision);
            requireValue(source?.messages.some(m => m.id === ref.messageId && m.role === ref.role), 'INVALID_SOURCE_REFERENCE');
        }
    }
}

function validateRecords(records: import('./contracts').KanbanRecordInput[], input: KanbanScanInput, changes: KanbanDiscoveryChange[]): void {
    requireValue(Array.isArray(records) && records.length <= 20, 'SCAN_RECORD_LIMIT');
    const ids = new Set<string>();
    for (const record of records) {
        identity(record.id); requireValue(!ids.has(record.id), 'INVALID_RECORD_ID'); ids.add(record.id);
        validateText(record.title); validateText(record.content);
        requireValue(['log', 'decision'].includes(record.kind), 'INVALID_RECORD_KIND');
        if (record.kind === 'decision') validateText(record.rationale ?? '');
        requireValue(Array.isArray(record.itemIds) && record.itemIds.every(id => input.board.items.some(item => item.id === id) || changes.some(change => change.action === 'create' && change.itemId === id)), 'UNKNOWN_CONTEXT_ITEM');
        if (record.supersedes) requireValue(input.projectContext?.records.some(old => old.id === record.supersedes && old.kind === 'decision'), 'UNKNOWN_CONTEXT_RECORD');
        requireValue(Array.isArray(record.sources) && record.sources.length > 0 && record.sources.length <= 100
            && record.sources.some(source => source.role === 'user'), 'USER_EVIDENCE_REQUIRED');
        for (const ref of record.sources) {
            const source = input.sessions.find(s => s.session.id === ref.sessionId && s.session.revision === ref.revision);
            requireValue(source?.messages.some(message => message.id === ref.messageId && message.role === ref.role), 'INVALID_SOURCE_REFERENCE');
        }
    }
}

function errorCode(error: unknown): string {
    const value = error as {code?: unknown; remoteCode?: unknown};
    const code = value?.remoteCode ?? value?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'SCAN_PORT_FAILURE';
}

function matchesScope(scope: import('./contracts').KanbanBoard['scope'], source: import('./scan-ports').KanbanScanSource): boolean {
    const expected = source.scope ?? (source.projectId ? {kind: 'project' as const, projectId: source.projectId} : undefined);
    if (!expected || scope.kind !== expected.kind) return false;
    if (scope.kind === 'system') return true;
    if (scope.kind === 'project' && expected.kind === 'project') return scope.projectId === expected.projectId;
    return scope.kind === 'collection' && expected.kind === 'collection' && scope.namespace === expected.namespace && scope.id === expected.id;
}
