import type {KanbanActor,KanbanBoard,KanbanCommand} from './contracts';
import {identity,requireValue} from './rules';
export function validateBoardSettings(settings:Record<string,string>|undefined):void {
    if(settings===undefined)return;
    requireValue(settings && typeof settings==='object' && (Object.getPrototypeOf(settings)===Object.prototype || Object.getPrototypeOf(settings)===null) && Object.keys(settings).length<=32,'INVALID_BOARD_SETTINGS');
    for(const [key,value]of Object.entries(settings)){
        identity(key);requireValue(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) && typeof value==='string' && value.length<=4096,'INVALID_BOARD_SETTINGS');
    }
}
/** Future admissions read new settings; frozen execution handles retain their own binding. */
export function configureBoardSettings(board:KanbanBoard,command:Extract<KanbanCommand,{type:'configure-board-settings'}>,actor:KanbanActor):void {
    requireValue(actor.kind==='human','FORBIDDEN');requireValue(!board.lifecycle,'BOARD_STOPPING');
    const {settings,executionSlots,executionSlotsPerAssignee}=command;
    requireValue(settings!==undefined,'INVALID_BOARD_SETTINGS');validateBoardSettings(settings);
    for(const value of [executionSlots,executionSlotsPerAssignee])
        requireValue(value===undefined || Number.isSafeInteger(value) && value>0,'INVALID_LIMIT');
    if(executionSlots!==undefined)board.policy.maxInProgress=executionSlots;
    if(executionSlotsPerAssignee!==undefined){
        board.policy.maxInProgressPerAssignee=executionSlotsPerAssignee;
        delete board.policy.maxInProgressPerAgent;
    }
    board.settings=structuredClone(settings);
}
