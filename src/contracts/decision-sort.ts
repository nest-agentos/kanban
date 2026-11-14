import type {KanbanDecisionRow as DecisionTableRow} from './decision-page';
import {DEFAULT_DECISION_SORT,decisionSorts,type DecisionSort} from './decision-page';
import {decisionRowPriority,decisionRowState} from './decision-row-state';

const textCollator=new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});
export function decisionSort(value:unknown):DecisionSort {
    return decisionSorts.includes(value as DecisionSort)?value as DecisionSort:DEFAULT_DECISION_SORT;
}
export function compareDecisionRows(left:DecisionTableRow,right:DecisionTableRow,sort:DecisionSort,projectLabel?:(row:DecisionTableRow)=>string,collator=textCollator):number {
    const byTitle=sort.startsWith('title-');
    const drafts=Number(right.kind==='conversation')-Number(left.kind==='conversation');
    if(byTitle&&drafts)return drafts;
    const activity=decisionRowState(right).lastActivityAt-decisionRowState(left).lastActivityAt;
    const created=right.value.createdAt-left.value.createdAt;
    const states=['draft','waiting','running','needs-action','checking','failed','cancelling','cancelled','completed','rejected','superseded'];
    const progress=states.indexOf(decisionRowState(left).state)-states.indexOf(decisionRowState(right).state);
    const projects=sort.startsWith('project-')?collator.compare(projectLabel?.(left)??'',projectLabel?.(right)??''):0;
    // Every page belongs to one board; the shared visible reference prefix is constant.
    const identifier=(row:DecisionTableRow)=>row.kind==='record'?String(row.value.number??row.value.id):'';
    const titles=byTitle?compareSegmentedIdentifiers(identifier(left),identifier(right),collator)||collator.compare(left.value.title??'',right.value.title??''):0;
    const orders:Record<DecisionSort,number>={
        'title-asc':titles,'title-desc':-titles,
        'activity-desc':activity,'activity-asc':-activity,'created-desc':created,'created-asc':-created,
        'progress-asc':progress,'progress-desc':-progress,'project-asc':projects,'project-desc':-projects,
        attention:sort==='attention'?decisionRowPriority(left)-decisionRowPriority(right)||activity:0,
    };
    return orders[sort]||left.value.id.localeCompare(right.value.id)||left.kind.localeCompare(right.kind);
}

/** Compare each numeric identifier segment as an integer, including values beyond Number precision. */
export function compareSegmentedIdentifiers(left:string,right:string,collator=textCollator):number {
    const a=left.split('-'),b=right.split('-');
    for(let index=0;index<Math.max(a.length,b.length);index++) {
        if(a[index]===undefined)return -1;
        if(b[index]===undefined)return 1;
        if(/^\d+$/.test(a[index])&&/^\d+$/.test(b[index])) {
            const x=BigInt(a[index]),y=BigInt(b[index]);
            if(x!==y)return x<y?-1:1;
        } else {
            const compared=collator.compare(a[index],b[index]);if(compared)return compared;
        }
    }
    return 0;
}
