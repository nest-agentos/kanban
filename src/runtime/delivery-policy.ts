import {requireValue} from '../rules';
/** Stable storage keys preserve existing host journals across the module migration. */
export const reviewKey=(board:string,item:string,scopeId?:string)=>'review-operations:'+JSON.stringify(scopeId?[board,item,scopeId]:[board,item]);
export const jobKey=(id:string)=>'review-operation:'+id;
export function selectDeliverySteps(configured:string[],canonical:string[],ordering?:'configured'):string[] {
    requireValue(configured.every(id=>canonical.includes(id)),'OPERATION_PLAN_ACTION_UNAVAILABLE');
    return (ordering==='configured'?[...new Set(configured)]:canonical).filter(id=>configured.includes(id));
}
