import type {KanbanActor,KanbanBoard,KanbanRestartPreview} from './contracts';
import type {KanbanRestartCommand} from './contracts/task-restart';
import type {KanbanState} from './ports';
import {sha256HexSync} from './utils';
import {identity,requireValue} from './rules';
import {requireCoordinator} from './workflow-plans';
import {applyTaskCommand} from './task-commands';
import {principal} from './identity';

/** Reverse edges define the affected set, independent of ordering and hierarchy. */
export function dependencyRestartPreview(board:KanbanBoard,itemId:string):KanbanRestartPreview {
    requireValue(board.items.some(item=>item.id===itemId&&!item.deletedAt),'ITEM_NOT_FOUND');
    const reverse=new Map<string,string[]>();for(const item of board.items.filter(item=>!item.deletedAt))for(const id of item.planning?.dependencies??[]){const rows=reverse.get(id)??[];rows.push(item.id);reverse.set(id,rows);}
    const ids=new Set([itemId]),queue=[itemId];for(let at=0;at<queue.length;at++)for(const id of reverse.get(queue[at])??[])if(!ids.has(id)){ids.add(id);queue.push(id);}
    requireValue(ids.size<=50,'RESTART_SCOPE_LIMIT');
    const items=board.items.filter(item=>ids.has(item.id));requireValue(items.every(item=>item.planning?.execution!=='children'&&!item.deletedAt),'RESTART_LEAF_TASK_REQUIRED');
    return {itemId,version:sha256HexSync(JSON.stringify(items.map(item=>[item.id,item.revision,item.status,item.planning?.dependencies]))),
        affected:items.map(item=>({id:item.id,title:item.title,number:item.number,status:item.status,started:item.launch?.admittedAt!==undefined}))};
}
export function applyDependencyRestart(state:KanbanState,command:KanbanRestartCommand,actor:KanbanActor,now:number):void {
    requireCoordinator(state,actor);requireValue(principal(actor).kind==='human','FORBIDDEN');identity(command.restartId);
    const preview=dependencyRestartPreview(state.board,command.itemId);
    if(command.type==='prepare-task-restart') {
        requireValue(preview.version===command.version,'RESTART_PREVIEW_CHANGED');
        for(const row of preview.affected){const item=state.board.items.find(item=>item.id===row.id)!;
            requireValue(!item.restartPending||item.restartPending.id===command.restartId,'RESTART_IN_PROGRESS');
            item.restartPending={id:command.restartId,rootItemId:command.itemId};
            if(!['completed','cancelled'].includes(item.status)){item.blocked={reason:'DEPENDENCY_RESTART_PENDING',at:now};applyTaskCommand(state,{type:'request-control',itemId:item.id,controlId:command.restartId+'-'+sha256HexSync(item.id).slice(0,12),action:'cancel'},actor,now);}
            item.revision++;item.updatedAt=now;
        }return;
    }
    requireValue(preview.affected.length===command.affectedIds.length&&preview.affected.every(row=>command.affectedIds.includes(row.id)),'RESTART_GRAPH_CHANGED');
    for(const row of preview.affected){const item=state.board.items.find(item=>item.id===row.id)!;
        requireValue(item.restartPending?.id===command.restartId&&(!item.owner||item.status==='completed')&&!item.transfer&&['completed','cancelled'].includes(item.status),'RESTART_STOP_PENDING');
        requireValue(!Object.values(state.workflow?.dispatches??{}).some(dispatch=>dispatch.itemId===item.id&&['prepared','running','unknown','succeeded'].includes(dispatch.outcome)),'RESTART_STOP_PENDING');
        reset(item,command.restartId,command.itemId,now);
    }
    reopenAncestors(state,command.restartId,now);
}
function reset(item:KanbanBoard['items'][number],epoch:string,root:string,now:number):void {
    item.status='backlog';item.executionEpoch=epoch;item.readyAt=now;item.updatedAt=now;item.revision++;
    item.launch={mode:item.launch?.mode??'automatic',startAt:now,analysisEpoch:epoch,...(item.id===root?{requestedAt:now}:{})};
    delete item.repairPending;delete item.owner;delete item.transfer;delete item.blocked;delete item.control;delete item.analysis;delete item.restartPending;delete item.closedAt;delete item.closureReason;delete item.resultRef;
    item.participants=item.participants.map(row=>({...row,subscribed:false}));
}

function reopenAncestors(state:KanbanState,epoch:string,now:number):void {
    const queue=state.board.items.filter(item=>item.executionEpoch===epoch),seen=new Set(queue.map(item=>item.id));
    for(let at=0;at<queue.length;at++) {
        const parent=state.board.items.find(item=>item.id===queue[at].planning?.parentId);if(!parent||seen.has(parent.id))continue;
        seen.add(parent.id);queue.push(parent);parent.executionEpoch=epoch;
        if(parent.status==='completed'){parent.status='backlog';delete parent.closedAt;delete parent.resultRef;}
        parent.revision++;parent.updatedAt=now;
    }
}
