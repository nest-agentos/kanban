import type {KanbanDecisionRow as DecisionTableRow} from './decision-page';
import {decisionSorts,type DecisionSort} from './decision-page';
import {decisionRowPriority,decisionRowState} from './decision-row-state';

const projectCollator=new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});
export function decisionSort(value:unknown):DecisionSort {
    return decisionSorts.includes(value as DecisionSort)?value as DecisionSort:'activity-desc';
}
export function compareDecisionRows(left:DecisionTableRow,right:DecisionTableRow,sort:DecisionSort,projectLabel?:(row:DecisionTableRow)=>string,collator=projectCollator):number {
    const activity=decisionRowState(right).lastActivityAt-decisionRowState(left).lastActivityAt;
    const created=right.value.createdAt-left.value.createdAt;
    const states=['draft','waiting','running','needs-action','checking','failed','cancelling','cancelled','completed','rejected','superseded'];
    const progress=states.indexOf(decisionRowState(left).state)-states.indexOf(decisionRowState(right).state);
    const projects=sort.startsWith('project-')?collator.compare(projectLabel?.(left)??'',projectLabel?.(right)??''):0;
    const orders:Record<DecisionSort,number>={
        'activity-desc':activity,'activity-asc':-activity,'created-desc':created,'created-asc':-created,
        'progress-asc':progress,'progress-desc':-progress,'project-asc':projects,'project-desc':-projects,
        attention:sort==='attention'?decisionRowPriority(left)-decisionRowPriority(right)||activity:0,
    };
    return orders[sort]||left.value.id.localeCompare(right.value.id)||left.kind.localeCompare(right.kind);
}
