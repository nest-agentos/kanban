import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {createKanbanActivityModule} from '../src/activity';
import type {KanbanCommand, KanbanExecutionSession, KanbanExternalReference} from '../src/contracts';
import {SeqKanbanStore} from '../src/storage';
const executionReference = (id: string, revision: string): KanbanExternalReference => ({system: 'external-job', id, revision});
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse()) await close();});
async function fixture(related?: import('../src/activity').KanbanSessionSource['related']) {
    const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());
    const fs=await manager.openFileSystem('/'),store=await SeqKanbanStore.open(fs),log=vi.fn();let now=1000000,serial=0;
    const states=new Map<string,Omit<KanbanExecutionSession,'recent'>>();
    const inspect=vi.fn(async(_board:unknown,id:string)=>{const state=states.get(id);if(!state) throw Object.assign(new Error('private text'),{code:'SESSION_NOT_FOUND'});return {...structuredClone(state),observedAt:now};});
    const service=createKanbanActivityModule({referenceSystem: 'external-job',store,actor:{kind:'human',id:'owner'},authorize:async()=>{},log,executionSessions:{source:{inspect,related},now:()=>now}});closes.push(()=>service.dispose());
    await service.create({id:'b',title:'Board',scope:{kind:'system'},members:[{kind:'human',id:'owner',responsibility:'Manage',roles:['coordinator','worker','reviewer']},{kind:'human',id:'visitor',responsibility:'Observe',roles:['reviewer']}],policy:{requireEstimate:false}});
    const run=async(command:KanbanCommand,actor=service)=>actor.execute('b',{operationId:`op-${++serial}`,expectedRevision:(await actor.read('b')).revision,command});
    const item=async(id:string)=>run({type:'create-item',item:{id,title:id,responsibility:'Work',acceptance:'Done'}});
    const bind=async(itemId:string,sessionId:string)=>run({type:'link-reference',itemId,reference:executionReference(sessionId,`binding-${++serial}`)});
    const state=(id:string,phase:KanbanExecutionSession['state'],age:number)=>states.set(id,{sessionId:id,title:id,state:phase,lastActivityAt:now-age,observedAt:now,stale:false});
    return {fs,store,service,run,item,bind,state,states,inspect,log,advance:(ms:number)=>{now+=ms;}};
}
it('binds WorkItem to its current execution Session, retains history and ignores discussion Sessions',async()=>{
    const f=await fixture();await f.item('one');await f.item('discussion-only');f.state('s1','running',100);f.state('s2','completed',120000);f.state('discussion','running',0);
    await f.run({type:'register-session',itemId:'discussion-only',sessionId:'discussion',role:'observer',subscribed:true});
    await f.bind('one','s1');await f.bind('one','s2');f.inspect.mockClear();
    const page=await f.service.queryActivity('b',{view:'all'});
    expect(page.items.find(item=>item.id==='one')?.execution).toMatchObject({sessionId:'s2',state:'completed',recent:true});expect(page.items.find(item=>item.id==='discussion-only')?.execution).toBeUndefined();
    expect(f.inspect.mock.calls.map(call=>call[1])).toEqual(['s2']);
    expect((await f.service.executionSession('b','one')).history.map(binding=>[binding.sessionId,binding.current])).toEqual([['s2',true],['s1',false]]);
    expect((await f.service.related('s1')).map(board=>board.id)).toEqual(['b']);
    expect((await f.service.item('b','one')).item.status).toBe('backlog');
});
it('groups continuation attempts under their original Session and keeps hooks and child Sessions from becoming primary', async () => {
    const related = vi.fn(async (_board, item) => item.id === 'work' ? [
        {sessionId: 'planner', purpose: 'planning' as const, execution: {id: 'analysis', purpose: 'planning' as const}},
        {sessionId: 'hook', purpose: 'finalization' as const}, {sessionId: 'fix', purpose: 'fix' as const},
    ] : []);
    const f = await fixture(related);
    for (const id of ['original', 'planner', 'hook', 'fix', 'child-session']) f.state(id, 'running', 0);
    await f.run({type:'publish-plan',plan:{schema:'kanban.plan/1',id:'p',revision:1,sealed:true,items:[{id:'work',title:'Work',responsibility:'Build',acceptance:'Done',assignee:{kind:'human',id:'owner'},dependsOn:[]}]}});
    await f.run({type:'prepare-dispatch',itemId:'work',dispatchId:'d1'});
    await f.run({type:'link-reference',itemId:'work',reference:executionReference('original','d1')});
    await f.run({type:'observe-execution',dispatchId:'d1',fence:(await f.service.workflow('b')).dispatches.d1.fence,outcome:'failed'});
    await f.run({type:'continue-execution',previousDispatchId:'d1',dispatchId:'d2'});
    await f.run({type:'link-reference',itemId:'work',reference:executionReference('original','d2')});
    await f.item('child'); await f.bind('child', 'child-session');
    const revision = (await f.service.read('b')).revision;
    const light = await f.service.executionSession('b', 'work');
    expect(light.sessions).toBeUndefined(); expect(related).not.toHaveBeenCalled();
    f.inspect.mockClear();
    const detail = await f.service.executionSession('b','work',{includeRelated:true});
    expect(detail.current?.sessionId).toBe('original');
    expect(detail.sessions).toHaveLength(4);
    expect(detail.sessions?.[0]).toMatchObject({sessionId:'original',current:true,executions:[{id:'d1',attempt:1,outcome:'failed'},{id:'d2',attempt:2,previousDispatchId:'d1'}]});
    expect(detail.sessions?.some(row=>row.sessionId==='child-session')).toBe(false);
    expect(f.inspect.mock.calls.map(call=>call[1]).sort()).toEqual(['fix','hook','original','planner']);
    expect((await f.service.read('b')).revision).toBe(revision);
});
it('retains known associations and a safe error code when supplemental history is unavailable', async () => {
    const f = await fixture(async () => {throw Object.assign(new Error('PRIVATE_BODY'), {code:'EIO'});});
    await f.item('one'); f.state('original','running',0); await f.bind('one','original');
    const detail = await f.service.executionSession('b','one',{includeRelated:true});
    expect(detail.sessionsCode).toBe('EIO'); expect(detail.sessions?.[0].sessionId).toBe('original');
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('PRIVATE_BODY');
    await expect(f.service.executionSession('b','one',{includeRelated:'yes'} as never)).rejects.toMatchObject({code:'INVALID_QUERY'});
});
it('does not present a previous attempt Session as the current executor while a new attempt is being prepared',async()=>{
    const f=await fixture();f.state('old','running',0);
    await f.run({type:'publish-plan',plan:{schema:'kanban.plan/1',id:'p',revision:1,sealed:true,items:[{id:'work',title:'Work',responsibility:'Build',acceptance:'Done',assignee:{kind:'human',id:'owner'},dependsOn:[]}]}});
    await f.run({type:'prepare-dispatch',itemId:'work',dispatchId:'old-d'});await f.run({type:'link-reference',itemId:'work',reference:executionReference('old','old-d')});
    const fence=(await f.service.workflow('b')).dispatches['old-d'].fence;
    await f.run({type:'observe-execution',dispatchId:'old-d',fence,outcome:'failed'});await f.run({type:'unblock-item',itemId:'work'});await f.run({type:'prepare-dispatch',itemId:'work',dispatchId:'new-d'});
    const detail=await f.service.executionSession('b','work');expect(detail.current).toBeUndefined();expect(detail.history[0].current).toBe(false);
    expect((await f.service.queryActivity('b',{view:'all',execution:'active'})).total).toBe(0);
});
it('filters the complete matching set before pagination and invalidates cursors on activity changes',async()=>{
    const f=await fixture();for(const id of ['a','b','c']) await f.item(id);
    f.state('quiet','idle',900000);f.state('running','running',900000);f.state('recent','completed',300000);
    await f.bind('a','quiet');await f.bind('b','running');await f.bind('c','recent');
    const page=await f.service.queryActivity('b',{view:'all',execution:'active',limit:1});expect(page.total).toBe(2);expect(page.items[0].id).toBe('b');
    const next=await f.service.queryActivity('b',{view:'all',execution:'active',limit:1,cursor:page.nextCursor});expect(next.items[0].id).toBe('c');
    expect((await f.service.queryActivity('b',{view:'all',execution:'recent'})).items.map(item=>item.id)).toEqual(['c']);
    f.advance(600001);await expect(f.service.queryActivity('b',{view:'all',execution:'active',limit:1,cursor:page.nextCursor})).rejects.toMatchObject({code:'CURSOR_STALE'});
    expect((await f.service.queryActivity('b',{view:'all',execution:'running'})).items.map(item=>item.id)).toEqual(['b']);
});
it('keeps stale state on transport failure without treating it as running or recent and hides revoked metadata',async()=>{
    const f=await fixture();await f.item('one');f.state('s','running',0);await f.bind('one','s');await f.service.queryActivity('b',{view:'all'});
    f.inspect.mockRejectedValueOnce(Object.assign(new Error('private body'),{code:'EIO'}));
    expect((await f.service.executionSession('b','one')).current).toMatchObject({state:'running',stale:true,recent:false,code:'EIO'});
    f.inspect.mockRejectedValueOnce(Object.assign(new Error('private body'),{code:'EIO'}));expect((await f.service.queryActivity('b',{view:'all',execution:'active'})).total).toBe(0);
    f.states.delete('s');expect((await f.service.executionSession('b','one')).current).toMatchObject({state:'unknown',stale:true});
    expect((await f.service.executionSession('b','one')).current?.title).toBeUndefined();expect(JSON.stringify(f.log.mock.calls)).not.toContain('private body');
});
it('rejects unauthorized binding and replacement of a Session belonging to an unsettled dispatch',async()=>{
    const f=await fixture();f.state('s1','running',0);f.state('s2','running',0);
    await f.run({type:'publish-plan',plan:{schema:'kanban.plan/1',id:'p',revision:1,sealed:true,items:[{id:'work',title:'Work',responsibility:'Build',acceptance:'Done',assignee:{kind:'human',id:'owner'},dependsOn:[]}]}});
    const visitor=createKanbanActivityModule({referenceSystem: 'external-job',store:f.store,actor:{kind:'human',id:'visitor'},authorize:async()=>{},log:f.log,executionSessions:{source:{inspect:f.inspect}}});closes.push(()=>visitor.dispose());
    await expect(f.run({type:'link-reference',itemId:'work',reference:executionReference('s1','manual')},visitor)).rejects.toMatchObject({code:'EXECUTION_SESSION_ASSIGNMENT_DENIED'});
    await f.run({type:'prepare-dispatch',itemId:'work',dispatchId:'d'});await f.run({type:'link-reference',itemId:'work',reference:executionReference('s1','d')});
    await expect(f.bind('work','s2')).rejects.toMatchObject({code:'EXECUTION_SESSION_LOCKED'});
    await expect(f.run({type:'link-reference',itemId:'work',reference:executionReference('s2','d')})).rejects.toMatchObject({code:'EXECUTION_SESSION_LOCKED'});
});

it('retains the original primary Session binding after independent acceptance',async()=>{
    const f=await fixture();f.state('original','completed',0);f.state('other','running',0);
    await f.run({type:'publish-plan',plan:{schema:'kanban.plan/1',id:'p',revision:1,sealed:true,items:[{id:'work',title:'Work',responsibility:'Build',acceptance:'Done',assignee:{kind:'human',id:'owner'},dependsOn:[]}]}});
    await f.run({type:'prepare-dispatch',itemId:'work',dispatchId:'d'});await f.run({type:'link-reference',itemId:'work',reference:executionReference('original','d')});
    const dispatch=(await f.service.workflow('b')).dispatches.d;await f.run({type:'observe-execution',dispatchId:'d',fence:dispatch.fence,outcome:'succeeded'});
    await f.store.update('b','reviewer-fixture','reviewer-fixture',state=>{state!.board.members!.push({kind:'human',id:'independent',responsibility:'Review',roles:['coordinator','reviewer']});return state!;});
    const reviewer=createKanbanActivityModule({referenceSystem:'external-job',store:f.store,actor:{kind:'human',id:'independent'},authorize:async()=>{},log:f.log});closes.push(()=>reviewer.dispose());
    await f.run({type:'accept-execution',dispatchId:'d',accept:true},reviewer);
    await expect(f.bind('work','other')).rejects.toMatchObject({code:'EXECUTION_SESSION_LOCKED'});
    expect((await f.service.executionSession('b','work')).current?.sessionId).toBe('original');
});
