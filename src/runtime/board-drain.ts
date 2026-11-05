import type {KanbanBoard, KanbanService} from '../contracts';
import type {KanbanTaskControlOptions as CallLifecyclePorts} from './control-ports';

import {analysisHistory} from './analysis-history';
import type {KanbanAutomationJournal} from './automation-journal';
import {journalCommand} from './journal-command';
/** Observe accepted analyses to completion, without adopting a new plan or starting another call. */
export async function drainBoardAnalyses(ports: CallLifecyclePorts, journal: KanbanAutomationJournal, board: KanbanBoard, service: KanbanService): Promise<void> {
    if (!board.lifecycle) return;
    for (const item of board.items) {
        const jobs = await analysisHistory(journal,board.id,item.id);
        const keys = (await journal.get<{keys:string[]}>('analysis-history:' + JSON.stringify([board.id,item.id])))?.keys ?? [];
        for (const job of jobs) {
            if (job.phase === 'settled' && job.status.state!=='clarification') continue;
            const key = keys[(await journal.getMany<{id:string}>(keys)).findIndex(row=>row?.id===job.id)];
            if (!key) continue;
            if(job.phase==='waiting-input'||job.status.state==='clarification'){const outcome=await ports.control.control({kind:'conversation',executionId:job.id,operationId:'drain:'+job.id,action:'cancel'});if(outcome!=='cancelled')continue;}
            const view = job.phase === 'submitting' ? await ports.control.inspect?.(job.id,job.id) : undefined;
            if (job.phase === 'submitting' && (!view || !view.settled)) continue;
            const saved = await journal.update<typeof job>(key,old=>old!.phase !== job.phase ? old! : {...old!,phase:'settled',terminalOutcome:view?.outcome??(job.phase==='prepared'?'cancelled':undefined),status:{...old!.status,state:'failed',code:'BOARD_STOPPED_AFTER_ANALYSIS'}});
            if (saved.phase === 'settled' && !['completed','cancelled'].includes(item.status) && item.control?.action !== 'cancel') await journalCommand(journal,service,board.id,'board-drained-analysis:'+JSON.stringify([board.id,job.id]),
                {type:'report-analysis',itemId:item.id,operationId:job.id,status:saved.status});
        }
    }
}
