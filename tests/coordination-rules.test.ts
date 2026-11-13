import {expect,it} from 'vitest';
import type {KanbanBoard,KanbanItem} from '../src/contracts';
import {compileCoordinationProposal,validateCoordinationResult,itemWithinRoots,itemsWithinRoots,managementTaskOwner} from '../src/runtime/coordination-rules';
const parent={id:'parent',title:'Research',responsibility:'Coordinate research',acceptance:'Reviewed',planning:{kind:'group'}} as KanbanItem;
const board={items:[parent],policy:{requireEstimate:false},workTypes:[{id:'group',label:'Group',rank:0,executable:false},{id:'study',label:'Study',rank:1,executable:true}],automation:{worker:{kind:'service',id:'researcher'}}} as KanbanBoard;
const task=(key:string,dependsOn:string[]=[])=>({key,title:key,responsibility:'Study',acceptance:'Review evidence',dependsOn});
const proposal=(tasks:unknown[])=>({schema:'kanban.coordination-proposal/1',type:'append',tasks});
const policy={idForKey:(key:string)=>'research-'+key,inheritReferences:()=>[{system:'research-resource',id:'paper'}]};
it('supports another host with its own identities, references and coordination actions',()=>{
    const result=compileCoordinationProposal(proposal([task('a'),task('b',['a'])]),parent,board,policy);
    expect(result.children).toMatchObject([{id:'research-a',externalRefs:[{system:'research-resource',id:'paper'}]},{id:'research-b',dependsOn:['research-a']}]);
    expect(()=>validateCoordinationResult({schema:'kanban.coordination/1',summary:'Review',suggestions:[{itemId:'research-a',action:'review-paper',reason:'Evidence ready'}]},result.children!,['review-paper'])).not.toThrow();
    expect(()=>validateCoordinationResult({schema:'kanban.coordination/1',summary:'Review',suggestions:[{itemId:'research-a',action:'deploy',reason:'Out of policy'}]},result.children!,['review-paper'])).toThrow();
});
it.each([
    {tasks:[null],code:'COORDINATION_PROPOSAL_INVALID'},
    {tasks:[task('a'),task('a')],code:'COORDINATION_PROPOSAL_INVALID'},
    {tasks:[task('a',['outside'])],code:'AUTOMATION_SUBTASK_DEPENDENCY_INVALID'},
    {tasks:[task('a',['b']),task('b',['a'])],code:'DEPENDENCY_CYCLE'},
])('rejects malformed or out-of-scope proposals ($code)',({tasks,code})=>{
    expect(()=>compileCoordinationProposal(proposal(tasks),parent,board,policy)).toThrowError(expect.objectContaining({code}));
});
it('rejects conflicting generated IDs, missing estimates and repair targets outside the parent',()=>{
    expect(()=>compileCoordinationProposal(proposal([task('a'),task('b')]),parent,board,{...policy,idForKey:()=> 'same'})).toThrow();
    expect(()=>compileCoordinationProposal(proposal([task('a')]),parent,{...board,policy:{...board.policy,requireEstimate:true}},policy)).toThrow();
    expect(()=>compileCoordinationProposal({...proposal([task('a')]),type:'repair',repairItemId:'foreign'},parent,board,policy)).toThrow();
});
it('checks result scope and limits without relying on an execution success receipt',()=>{
    for(const output of [null,{schema:'kanban.coordination/1',summary:'x'.repeat(8001),suggestions:[]},{schema:'kanban.coordination/1',summary:'x',suggestions:[{itemId:'foreign',action:'review-paper',reason:'x'}]},{schema:'kanban.coordination/1',summary:'x',suggestions:[null]}])expect(()=>validateCoordinationResult(output,[{id:'a'}],['review-paper'])).toThrow();
});
it('shares descendant scoping while terminating corrupt ancestry and preserving explicit history queries',()=>{
    const items=[parent,{id:'child',planning:{parentId:'parent'}},{id:'archived',deletedAt:1,planning:{parentId:'child'}},{id:'loop-a',planning:{parentId:'loop-b'}},{id:'loop-b',planning:{parentId:'loop-a'}}] as KanbanItem[];
    expect(itemsWithinRoots(items,['parent']).map(row=>row.id)).toEqual(['parent','child']);
    expect(itemsWithinRoots(items,['parent'],{includeDeleted:true}).map(row=>row.id)).toEqual(['parent','child','archived']);expect(itemWithinRoots(items,'loop-a',['parent'])).toBe(false);
});

it('resolves the management owner from ancestry and fails closed for broken or cyclic links',()=>{
    const root={id:'root',planning:{execution:'children'}},group={id:'group',planning:{execution:'children',parentId:'root'}},child={id:'child',planning:{parentId:'group'}};
    const value={...board,items:[root,group,child]} as KanbanBoard;
    expect(managementTaskOwner(value,child as KanbanItem)?.id).toBe('root');
    expect(()=>managementTaskOwner({...value,items:[child]} as KanbanBoard,child as KanbanItem)).toThrow('OPERATION_OWNER_INVALID');
    expect(()=>managementTaskOwner({...value,items:[{...root,planning:{execution:'children',parentId:'child'}},group,child]} as KanbanBoard,child as KanbanItem)).toThrow('OPERATION_OWNER_INVALID');
});

it('resolves archived ancestors by stable ID without reading already visible items',async()=>{
 const {resolveManagementTaskOwner}=await import('@nestos/kanban/integration');
 const child={id:'child',planning:{parentId:'group'}},group={id:'group',planning:{parentId:'root',execution:'children'}},root={id:'root',planning:{execution:'children'}};
 const reads:string[]=[];const read=async(id:string)=>{reads.push(id);return id==='root'?root:undefined;};
 expect(await resolveManagementTaskOwner({items:[child,group]},child,read)).toBe(root);expect(reads).toEqual(['root']);
 expect(child.planning.parentId).toBe('group');expect(group.planning.parentId).toBe('root');
});
it('distinguishes missing, deleted and cyclic parent identities',async()=>{
 const {resolveManagementTaskOwner}=await import('@nestos/kanban/integration');const child={id:'child',planning:{parentId:'parent'}};
 await expect(resolveManagementTaskOwner({items:[child]},child,async()=>undefined)).rejects.toMatchObject({code:'OPERATION_OWNER_INVALID',reason:'parent-missing',itemId:'child',parentId:'parent'});
 await expect(resolveManagementTaskOwner({items:[child]},child,async()=>({id:'parent',deletedAt:1}))).rejects.toMatchObject({reason:'parent-deleted',parentId:'parent'});
 await expect(resolveManagementTaskOwner({items:[child]},child,async()=>({id:'parent',planning:{parentId:'child'}}))).rejects.toMatchObject({reason:'cycle',parentId:'child'});
});
