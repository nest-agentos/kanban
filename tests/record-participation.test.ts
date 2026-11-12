import {expect,it} from 'vitest';
import {recordProgress} from '../src/record-progress';
import type {KanbanItemSummary,KanbanTaskProjection,KanbanRecordSummary} from '../src/contracts';
type Fact={item:KanbanItemSummary;task:KanbanTaskProjection};
const record={id:'decision',kind:'decision',status:'confirmed',createdAt:1,updatedAt:2,itemIds:['manager'],sessionIds:[]} as KanbanRecordSummary;
function fact(id:string,phase:KanbanTaskProjection['phase'],manager=false):Fact {
    return {item:{id,title:'Title '+id,createdAt:1,updatedAt:2,status:'open',taskType:manager?'coordination':'execution',
        planning:{kind:'work',execution:manager?'children':'direct',...(manager?{}:{parentId:'manager'}),priority:1,dependencies:[],references:[]},sessionIds:[],revision:1},
        task:{phase,sessionId:'session-'+id,actions:[]}};
}
const project=(facts:Fact[])=>recordProgress(record,facts).participation!;
it('prefers the active execution conversation over the inherited management summary',()=>{
    expect(project([fact('manager','running',true),fact('child','running')])).toMatchObject({reason:'running',targets:[{itemId:'child',purpose:'execution'}]});
});
it('prefers management-owned input over a running execution',()=>{
    const manager=fact('manager','waiting-input',true);manager.item.analysis={itemId:'manager',state:'blocked',handler:'self'};
    expect(project([manager,fact('child','running')])).toMatchObject({reason:'needs-action',targets:[{itemId:'manager',purpose:'management'}]});
});
it('follows explicit parent responsibility and deduplicates multiple child issues handled by one manager',()=>{
    const children=['a','b'].map(id=>{const row=fact(id,'waiting-input');row.item.issues=[{id:'issue-'+id,type:'clarification',attemptId:id,handler:'parent'}];return row;});
    expect(project([fact('manager','waiting-input',true),...children])).toMatchObject({reason:'needs-action',targets:[{itemId:'manager',purpose:'management'}]});
    expect(project([fact('manager','waiting-input',true),...children]).targets).toHaveLength(1);
});
it('keeps a self-handled execution failure in its own conversation',()=>{
    const child=fact('child','error');child.item.issues=[{id:'issue',type:'error',attemptId:'attempt',handler:'self'}];
    expect(project([fact('manager','error',true),child]).targets).toEqual([{itemId:'child',title:'Title child',phase:'error',purpose:'execution'}]);
});
it('offers all independently running executions in stable order',()=>{
    const rows=[fact('manager','running',true),fact('b','running'),fact('a','running')];
    expect(project(rows).targets.map(row=>row.itemId)).toEqual(['a','b']);
    expect(project(rows.reverse()).targets.map(row=>row.itemId)).toEqual(['a','b']);
});
it('does not offer duplicate choices for executions with the same bound Session',()=>{
    const a=fact('a','running'),b=fact('b','running');b.task.sessionId=a.task.sessionId;
    expect(project([fact('manager','running',true),a,b]).targets).toHaveLength(1);
});
it('returns to management after settlement despite retained execution history',()=>{
    expect(project([fact('manager','completed',true),fact('child','running')])).toMatchObject({reason:'management',targets:[{itemId:'manager',purpose:'management'}]});
});
it('does not promote a queued or unbound execution into the participation entry',()=>{
    const child=fact('child','preparing');delete child.task.sessionId;
    expect(project([fact('manager','analyzing',true),child]).targets[0].purpose).toBe('management');
});
it('leaves draft participation to the decision conversation and falls back conservatively for partial summaries',()=>{
    const manager=fact('manager','running',true);manager.item.progress={total:3,completed:0,cancelled:0,inProgress:2};
    expect(recordProgress({...record,status:'draft'},[manager]).participation).toBeUndefined();
    expect(project([manager])).toMatchObject({reason:'management',targets:[{itemId:'manager',purpose:'management'}]});
});
