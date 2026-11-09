import type {KanbanActor,KanbanBoard} from './contracts';
import {identity,requireValue} from './rules';
export function validateBoardSettings(settings:Record<string,string>|undefined):void {
    if(settings===undefined)return;
    requireValue(settings && typeof settings==='object' && (Object.getPrototypeOf(settings)===Object.prototype || Object.getPrototypeOf(settings)===null) && Object.keys(settings).length<=32,'INVALID_BOARD_SETTINGS');
    for(const [key,value]of Object.entries(settings)){
        identity(key);requireValue(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) && typeof value==='string' && value.length<=4096,'INVALID_BOARD_SETTINGS');
    }
}
/** Future admissions read new settings; frozen execution handles retain their own binding. */
export function configureBoardSettings(board:KanbanBoard,settings:Record<string,string>,actor:KanbanActor):void {
    requireValue(actor.kind==='human','FORBIDDEN');requireValue(!board.lifecycle,'BOARD_STOPPING');
    requireValue(settings!==undefined,'INVALID_BOARD_SETTINGS');validateBoardSettings(settings);board.settings=structuredClone(settings);
}
