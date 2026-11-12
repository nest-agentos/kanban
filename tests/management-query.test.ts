import {expect,it,vi} from 'vitest';
import {createBoardState} from '../src/board';
import {queryItems} from '../src/queries';
import {querySessionItems} from '../src/session-activity-query';
import {reduce} from '../src/reducer';
import type {KanbanItem,KanbanService} from '../src/contracts';

function item(id:string,extra:Partial<KanbanItem>={}):KanbanItem {
    return {id,title:id,responsibility:'Work',acceptance:'Verified',status:'open',revision:1,createdAt:1,updatedAt:1,readyAt:1,workUnits:0,participants:[],
        planning:{kind:'task',priority:2,dependencies:[],references:[]},...extra};
}
function fixture(){
    const state=createBoardState({id:'board',title:'Board',scope:{kind:'system'},members:[{kind:'human',id:'owner',responsibility:'Manage',roles:['coordinator']}]},{kind:'human',id:'owner'},1);
    const manager=item('manager',{purpose:'planning',planning:{kind:'task',execution:'children',priority:2,dependencies:[],references:[]}});
    const children=Array.from({length:10},(_,index)=>item('child-'+index,{planning:{kind:'task',parentId:'manager',priority:2,dependencies:[],references:[]}}));
    children[8].blocked={reason:'WORKSPACE_INPUT_REQUIRED',at:1};children[9].status='completed';
    state.board.items=[manager,...children,item('standalone')];return {state,manager,children};
}
it('paginates management roots, includes planning tasks and bounds unfinished previews with attention first',()=>{
    const f=fixture(),page=queryItems(f.state,{view:'all',groupBy:'management',limit:1},undefined,2);
    expect(page.total).toBe(2);expect(page.items[0]).toMatchObject({id:'manager',taskType:'coordination',task:{phase:'waiting-input'}});
    expect(page.groups?.[0]).toMatchObject({parentId:'manager',total:9});expect(page.groups?.[0].items).toHaveLength(6);
    expect(page.groups?.[0].items[0].id).toBe('child-8');expect(page.groups?.[0].items.some(row=>row.id==='child-9')).toBe(false);
    const next=queryItems(f.state,{view:'all',groupBy:'management',limit:1,cursor:page.nextCursor},undefined,2);
    expect(next.items.map(row=>row.id)).toEqual(['standalone']);
});
it('retains the manager for child search and phase filters and places aggregate progress in the active view',()=>{
    const f=fixture();
    for(const filters of [{search:'child-8'},{phase:'waiting-input' as const},{view:'in-progress' as const}]){
        const page=queryItems(f.state,{view:'all',groupBy:'management',...filters},undefined,2);
        expect(page.items.map(row=>row.id)).toEqual(['manager']);expect(page.groups?.[0].items[0].id).toBe('child-8');
    }
    expect(queryItems(f.state,{view:'all',parentId:'manager',limit:1},undefined,2).attentionItems?.[0].id).toBe('child-8');
    expect(()=>queryItems(f.state,{groupBy:'invalid'} as never)).toThrow('INVALID_GROUPING');
});
it('preserves management identity after planning finishes and tags task event streams',()=>{
    const f=fixture();delete f.manager.purpose;delete f.manager.planning!.execution;
    let state=reduce(f.state,{type:'mark-planning',itemId:'manager'},{kind:'human',id:'owner'},'mark',2,'token');
    state=reduce(state,{type:'finish-planning',itemId:'manager'},{kind:'human',id:'owner'},'finish',3,'token');
    expect(state.board.items[0].taskType).toBe('coordination');expect(state.board.items[0].purpose).toBeUndefined();
    expect(state.events.find(event=>event.kind==='finish-planning')?.taskType).toBe('coordination');
});
it('projects preview activity in one batch and retains managers when a matching Session is outside the default preview',async()=>{
    const f=fixture(),query=vi.fn(async(_id:string,input:any)=>queryItems(f.state,input,undefined,2));
    const core={query} as unknown as KanbanService;
    const project=vi.fn(async(rows:any[])=>rows.map(row=>({...row,...(row.id==='child-7'?{execution:{sessionId:'original',resourceId:'/native/original',state:'running',stale:false,recent:true}}:{})})));
    await querySessionItems(core,'board',{view:'all',groupBy:'management'},project);
    expect(project).toHaveBeenCalledTimes(1);expect(project.mock.calls[0][0].length).toBe(8);
    const filtered=await querySessionItems(core,'board',{view:'all',groupBy:'management',execution:'running',search:'child-7'},project);
    expect(filtered.total).toBe(1);expect(filtered.items[0].id).toBe('manager');
    expect(filtered.groups?.[0].parentId).toBe('manager');expect(filtered.groups?.[0].items[0]).toMatchObject({id:'child-7',execution:{resourceId:'/native/original'}});
});

it('keeps closed and archive views flat instead of promoting a completed child into an active manager',()=>{
 const f=fixture(),closed=queryItems(f.state,{view:'closed',groupBy:'management'},undefined,2);
 expect(closed.items.map(row=>row.id)).toEqual(['child-9']);expect(closed.groups).toBeUndefined();
});
