import type {KanbanAutomationJournal} from './automation-journal';
import type {KanbanTaskControlOptions,KanbanControlState} from './control-ports';
export function controlExecution(options:KanbanTaskControlOptions,_journal:KanbanAutomationJournal,executionId:string,operationId:string,
    action:'pause'|'resume'|'cancel',attemptId=executionId,previousKey?:string,direct=false,observationSessionId?:string):Promise<KanbanControlState> {
    return options.control.control({observationSessionId,executionId,operationId,action,attemptId,previousKey,...(direct?{fallbackSubmission:true}:{})});
}
