import {runtimeLogger} from './logging';
import {safeCode} from './diagnostics';
import {sha256HexSync} from '../utils';
import type {KanbanClient, KanbanFixSession} from '../contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import type {TaskControlPorts} from './task-controls';
import {cancelTaskMaintenance} from './task-maintenance-cancellation';
import {cancelTaskReplies} from './task-reply-cancellation';
interface Options {service:KanbanClient;journal:KanbanAutomationJournal;ports:TaskControlPorts;
    fixes?:{cancelFix(board:string,request:{fixId:string;operationId:string}):Promise<KanbanFixSession>};
    records?:{controlRecord(board:string,request:{recordId:string;operationId:string;action:'cancel'}):Promise<void>}}
/** Cancellation is explicit; drain mode only freezes future admissions and retains user settlement choices. */
export async function scanBoardStopWork(options:Options):Promise<void> {
    for (const board of await options.service.list()) {
        if (board.lifecycle?.mode !== 'cancel' || board.lifecycle.phase === 'ready') continue;
        const control=board.lifecycle.operationId;
        if (options.fixes) for (const row of await options.journal.findForBoard<{id:string;accepted?:boolean;state:string}>('fix:',board.id,fix=>!fix.accepted&&fix.state!=='cancelled'))
            await attempt(options.journal,board.id,control,'fix.cancel',()=>options.fixes!.cancelFix(board.id,{fixId:row.value.id,operationId:sha256HexSync(JSON.stringify([control,row.value.id]))}));
        if (options.records) for (const run of (await options.journal.get<Array<{recordId:string}>>('record-runs:'+board.id))??[]) {
            const key='record-control:'+JSON.stringify([board.id,run.recordId]);
            if ((await options.journal.get<{action:string}>(key))?.action !== 'cancel') await attempt(options.journal,board.id,control,'record.cancel',()=>options.records!.controlRecord(board.id,{recordId:run.recordId,operationId:sha256HexSync(JSON.stringify([control,run.recordId])),action:'cancel'}));
        }
        for (const item of board.items.filter(item=>['completed','cancelled'].includes(item.status))) {
            const id=sha256HexSync(JSON.stringify([control,item.id]));
            await attempt(options.journal,board.id,control,'reply.cancel',()=>cancelTaskReplies(options.ports,options.journal,board.id,item.id,id));
            await attempt(options.journal,board.id,control,'maintenance.cancel',()=>cancelTaskMaintenance(options.ports,options.journal,board.id,item.id,id));
        }
    }
}

async function attempt(journal:KanbanAutomationJournal,boardId:string,operationId:string,stage:string,run:()=>Promise<unknown>):Promise<void> {
    const started=Date.now();
    try {await run();} catch(error) {runtimeLogger(journal).warn('Board work settlement pending',{operation:'kanban.board.stop',operationId,boardId,stage,result:'failure',code:safeCode(error,'BOARD_WORK_STOP_UNKNOWN'),durationMs:Date.now()-started});}
}
