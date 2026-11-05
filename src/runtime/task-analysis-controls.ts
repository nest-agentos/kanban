import type {KanbanItem, KanbanTaskControl} from '../contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import {analysisHistory} from './analysis-history';
import type {KanbanTaskControlOptions as CallLifecyclePorts} from './control-ports';
import {controlExecution as controlCall} from './control';
import {requireValue} from '../rules';
type Job = Awaited<ReturnType<typeof analysisHistory>>[number];
/** Every historical unsettled analysis must acknowledge control before the task can settle. */
export async function controlTaskAnalyses(options: CallLifecyclePorts, journal: KanbanAutomationJournal, board: string, item: KanbanItem): Promise<KanbanTaskControl['state'] | undefined> {
    const analyses = await analysisHistory(journal, board, item.id);
    requireValue(analyses.length || !['analyzing','unknown'].includes(item.analysis?.state ?? ''), 'TASK_CONTROL_ROUTE_MISSING');
    const keys = (await journal.get<{keys: string[]}>('analysis-history:' + JSON.stringify([board, item.id])))?.keys ?? [];
    const byId = new Map((await journal.getMany<Job>(keys)).flatMap((job, index) => job ? [[job.id, keys[index]] as const] : []));
    for (const job of analyses) {
        if (job.phase === 'settled' && job.status.state!=='clarification') continue;
        const key = byId.get(job.id); requireValue(key, 'TASK_CONTROL_ROUTE_MISSING');
        const state = await controlAnalysis(options,journal,key,job,item.control!);
        if (state) return state;
    }
}
async function controlAnalysis(options: CallLifecyclePorts, journal: KanbanAutomationJournal, key: string, job: Job, control: KanbanTaskControl): Promise<KanbanTaskControl['state'] | undefined> {
    if (control.action === 'cancel') {
        const current = await journal.update<Job>(key, old => old!.phase === 'prepared' ? cancelled(old!) : old!);
        if (current.phase === 'settled' && current.status.state!=='clarification') return;
    } else if (job.phase === 'prepared') return;
    const state = job.phase==='waiting-input'||job.status.state==='clarification' ? await options.control.control({kind:'conversation',executionId:job.id,operationId:control.id+'-analysis-'+job.id,action:control.action})
        : await controlCall(options,journal,job.id,control.id + '-analysis-' + job.id,control.action);
    const target = control.action === 'pause' ? 'paused' : control.action === 'resume' ? 'resumed' : 'cancelled';
    if (state !== target) return state;
    if (control.action === 'cancel') await journal.update<Job>(key, old => cancelled(old!));
}
function cancelled(job: Job): Job {
    return {...job,phase:'settled',terminalOutcome:'cancelled',status:{...job.status,state:'failed',code:'USER_CANCELLED'}};
}
