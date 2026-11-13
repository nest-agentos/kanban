import type {KanbanItemOperations} from '../contracts';
import type {AutomaticDeliveryState as State,AutomaticDeliveryOptions as Options} from './automatic-delivery-types';
export const deliveryKey=(board:string,item:string,scopeId?:string)=>'automatic-delivery:'+JSON.stringify(scopeId?[board,item,scopeId]:[board,item]);
export const deliverySteps=(state:State)=>state.steps??[];
export const deliveryNeedsTarget=(state:State)=>!state.targetActions||state.targetActions.includes(deliverySteps(state)[state.step]);
export const deliveryComplete=(state:State|undefined):boolean=>!!state&&!state.code&&(!!state.handoff||Array.isArray(state.steps)&&state.step>=deliverySteps(state).length);
export function deliveryNeedsAuthority(state:State):boolean {
    const steps=state.manualOrder??deliverySteps(state),action=deliverySteps(state)[state.step];
    return !deliveryComplete(state)&&!!state.manualAfter&&steps.indexOf(action)>steps.indexOf(state.manualAfter);
}
/** Compatibility fields are projected for consumers, never a second persisted source of truth. */
export async function reportDelivery(options:Options,state:State):Promise<void> {
    await options.report?.({...state,done:deliveryComplete(state),waitingForUser:deliveryNeedsAuthority(state)});
}
export function deliveryStatus(state:State):NonNullable<KanbanItemOperations['automatic']> {
    const completed=deliveryComplete(state),waitingForUser=deliveryNeedsAuthority(state);
    const code=state.code??(state.done&&!completed?'AUTOMATIC_DELIVERY_INCOMPLETE':undefined);
    return {state:code?'blocked':completed?'completed':waitingForUser?'waiting-confirmation':'running',waitingForUser,
        stage:deliverySteps(state)[state.step]??'completed',code,...(state.waitingForTarget?{waitingForTarget:true}:{}),
        ...(waitingForUser?{attention:{kind:'authorization' as const}}:code==='OPERATION_SELECTION_REQUIRED'?{attention:{kind:'choice' as const}}:code==='OPERATION_OUTCOME_UNKNOWN'?{attention:{kind:'recovery' as const}}:{})};
}
