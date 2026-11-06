import type {KanbanActor, KanbanService} from '../contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import {journalCommand} from './journal-command';

/** Completing a composite never starts another execution or substitutes for child acceptance. */
export async function completeCompositePlans(service:KanbanService,journal:KanbanAutomationJournal,boardId:string,serviceFor:(actor:KanbanActor)=>KanbanService,ready?:(board:string,item:import('../contracts').KanbanItem)=>Promise<boolean>):Promise<void> {
    const workflow=await service.workflow(boardId),boardSnapshot=await service.read(boardId);
    const roots=new Set(boardSnapshot.items.filter(item=>item.planning?.execution==='children').map(item=>item.id));
    for(const id of roots) {
        const board=await service.read(boardId),parent=board.items.find(item=>item.id===id);
        if(!board.automation||!parent||parent.control?.action==='cancel'||parent.owner||parent.blocked||parent.planning?.execution!=='children'||!['backlog','open'].includes(parent.status))continue;
        if(!await childrenCompleted(service,boardId,id))continue;
        if(ready){const children=board.items.filter(item=>item.planning?.parentId===id);if(!(await Promise.all(children.map(item=>ready(boardId,item)))).every(Boolean))continue;}
        await journalCommand(journal,serviceFor(board.automation.coordinator),boardId,'aggregate-complete:'+id+':'+(parent.executionEpoch??Object.values(workflow.plans).filter(plan=>plan.rootItemId===id).map(plan=>plan.id+':'+plan.revision).sort().join(',')),
            {type:'close-plan',itemId:id,resultRef:'kanban:plans:'+JSON.stringify(Object.values(workflow.plans).filter(plan=>plan.rootItemId===id).map(plan=>plan.id))});
    }
}

async function childrenCompleted(service:KanbanService,boardId:string,parentId:string):Promise<boolean> {
    let cursor:string|undefined,count=0;
    do {
        const page=await service.query(boardId,{view:'all',parentId,limit:200,cursor});
        if(page.items.some(item=>item.status!=='completed'))return false;
        count+=page.items.length;cursor=page.nextCursor;
    }while(cursor);
    return count>0;
}
