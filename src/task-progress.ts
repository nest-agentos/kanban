import type {KanbanProgress,KanbanTaskPhase} from './contracts';

const fields:Partial<Record<KanbanTaskPhase,Exclude<keyof KanbanProgress,'phases'>>>={completed:'completed',cancelled:'cancelled',running:'inProgress',preparing:'inProgress',analyzing:'inProgress',queued:'inProgress',resuming:'inProgress',
    'waiting-input':'waitingInput',error:'errors',unknown:'errors',review:'review',paused:'paused',pausing:'paused','waiting-start':'waiting','waiting-dependency':'waiting'};
export function emptyTaskProgress():KanbanProgress {
    return {total:0,completed:0,cancelled:0,inProgress:0,waitingInput:0,errors:0,review:0,paused:0,waiting:0,phases:{}};
}
export function addTaskProgress(progress:KanbanProgress,phase?:KanbanTaskPhase):void {
    progress.total++;const field=phase&&fields[phase];if(field)progress[field]++;
    if(phase){progress.phases??={};progress.phases[phase]=(progress.phases[phase]??0)+1;}
}
export function mergeTaskProgress(target:KanbanProgress,source:Partial<KanbanProgress>):void {
    for(const [key,value]of Object.entries(source))if(key!=='phases'&&typeof value==='number'&&key in target)target[key as Exclude<keyof KanbanProgress,'phases'>]+=value;
    for(const [phase,count]of Object.entries(source.phases??{})){target.phases??={};const key=phase as KanbanTaskPhase;target.phases[key]=(target.phases[key]??0)+(count??0);}
}
export function taskProgress(phases:Array<KanbanTaskPhase|undefined>):KanbanProgress {
    const progress=emptyTaskProgress();for(const phase of phases)addTaskProgress(progress,phase);return progress;
}
