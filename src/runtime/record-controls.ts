import {sha256HexSync} from '../utils';
import type {KanbanClient, KanbanItem, KanbanRecordExecution} from '../contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import {journalCommand} from './journal-command';
import {requireValue} from '../rules';

export interface RecordControl {boardId?: string; recordId?: string; operationId: string; action: 'pause' | 'resume' | 'cancel'; controls: Record<string, string>; settled?: boolean; after?:'archive'|'delete'|'restart'}
export const recordControlKey = (board: string, record: string) => 'record-control:' + JSON.stringify([board, record]);
/** Only already materialized work is controlled; cancellation never creates missing work. */
export async function advanceRecordControl(service: KanbanClient, journal: KanbanAutomationJournal,
    run: KanbanRecordExecution & {sourceBoardId: string}, control: RecordControl): Promise<KanbanRecordExecution['state']> {
    const ids = new Set([run.rootItemId,...run.itemIds??[]].filter((id):id is string=>!!id));
    let board;
    try {board = await service.read(run.boardId);}
    catch (error) {if (control.action === 'cancel' && (error as {code?: string}).code === 'BOARD_NOT_FOUND') return 'cancelled'; throw error;}
    let items = board.items.filter(item => ids.has(item.id));
    for (let index = 0; index < board.items.length; index++) {
        const children = board.items.filter(item=>item.planning?.parentId&&ids.has(item.planning.parentId));
        if (children.every(item => ids.has(item.id))) break;
        for (const child of children) ids.add(child.id);
    }
    items = board.items.filter(item => ids.has(item.id));
    const operations=control.action==='cancel'?(await Promise.all(['review-operation:','coordination-operation:','fix:'].map(prefix=>journal.findForBoard<{itemId:string;phase:string;state?:string;accepted?:boolean}>(prefix,run.boardId,job=>job.phase!=='settled'&&!job.accepted&&job.state!=='cancelled')))).flat():[];
    const pending=new Set(operations.map(row=>row.value.itemId));
    for(const item of items) {
        if(!['completed','cancelled'].includes(item.status)||pending.has(item.id))await requestItemControl(service,journal,run,control,item);
    }
    const latest = await service.read(run.boardId), active = latest.items.filter(item => ids.has(item.id) && (!['completed','cancelled'].includes(item.status)||item.control?.action==='cancel'&&item.control.state!=='cancelled'));
    if (control.action === 'cancel') return active.length ? 'cancelling' : 'cancelled';
    const managed = active.filter(item => control.controls[item.id]);
    if (managed.some(item => item.control?.state === 'unknown')) return 'unknown';
    if (managed.some(item => item.control?.state === 'failed')) return 'blocked';
    const target = control.action === 'pause' ? 'paused' : 'resumed';
    return managed.every(item => item.control?.state === target) ? control.action === 'pause' ? 'paused' : 'running' : control.action === 'pause' ? 'pausing' : 'resuming';
}
async function requestItemControl(service: KanbanClient, journal: KanbanAutomationJournal, run: KanbanRecordExecution & {sourceBoardId: string}, control: RecordControl, item: KanbanItem): Promise<void> {
    if(control.action!=='cancel'&&item.planning?.execution==='children')return;
    const action = control.action, controlId = sha256HexSync(JSON.stringify([run.sourceBoardId, run.recordId, control.operationId, run.boardId, item.id, action]));
    if (item.control?.id !== controlId) {
        if (action === 'resume' && (!control.controls[item.id] || item.control?.id !== control.controls[item.id])) return;
        if (action === 'pause' && item.control?.action === 'pause') return;
        await journalCommand(journal, service, run.boardId, 'record-control-item:' + controlId,
            {type: 'request-control', itemId: item.id, controlId, action});
    }
    const saved = await journal.update<RecordControl>(recordControlKey(run.sourceBoardId, run.recordId), old => ({...old!, controls: {...old!.controls, [item.id]: controlId}}));
    control.controls = saved.controls;
}
export async function requestRecordControl(service: KanbanClient, journal: KanbanAutomationJournal, boardId: string,
    request: {recordId: string; operationId: string; action: RecordControl['action']|'archive'|'delete'|'restart';expectedRevision?:number}): Promise<void> {
    requireValue(/^[\w-]{1,128}$/.test(request.operationId) && ['pause','resume','cancel','archive','delete','restart'].includes(request.action), 'INVALID_RECORD_CONTROL');
    const board = await service.read(boardId), actor = await service.currentPrincipal(), record = await service.record(boardId, request.recordId);
    requireValue(actor.kind === 'human' && board.members?.some(m => m.kind === actor.kind && m.id === actor.id && m.roles?.includes('coordinator')), 'COORDINATOR_REQUIRED');
    requireValue(record.kind==='decision','DECISION_REQUIRED');
    const after=['archive','delete','restart'].includes(request.action)?request.action as RecordControl['after']:undefined,action=after?'cancel':request.action as RecordControl['action'];
    await journal.update<RecordControl>(recordControlKey(boardId, record.id), old => {
        if (old?.operationId === request.operationId) {requireValue(old.action===action&&old.after===after,'IDEMPOTENCY_CONFLICT'); return old;}
        requireValue(record.deletedAt===undefined,'RECORD_DELETED');
        requireValue(request.expectedRevision===undefined||request.expectedRevision===record.revision,'REVISION_CONFLICT');
        requireValue(!old || old.action !== 'cancel'||old.settled, 'RECORD_CANCELLING');
        requireValue(request.action !== 'resume' || old?.action === 'pause', 'TASK_NOT_PAUSED');
        return {boardId, recordId: record.id, operationId: request.operationId, action,after, controls: old?.controls ?? {}};
    });
    if(action==='cancel'&&record.deletedAt===undefined)await journalCommand(journal, service, boardId, 'record-cancelling:' + JSON.stringify([boardId,record.id,request.operationId]), {type:'request-record-cancellation',recordId:record.id});
}
