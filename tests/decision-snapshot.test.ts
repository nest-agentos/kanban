import {expect,it,vi} from 'vitest';
import {decisionSnapshot} from '../src/runtime/decision-page';
import type {KanbanClient,KanbanRecordSummary} from '../src/contracts';
const record=(id:string):KanbanRecordSummary=>({id,kind:'decision',status:'confirmed',title:id,createdAt:1,updatedAt:2,itemIds:['task'],sessionIds:[],progress:{state:'running',lastActivityAt:2}});
function fixture(items=[record('decision')]) {
    const records=vi.fn(async()=>({revision:3,total:items.length,items})),recordConversations=vi.fn(async()=>[{id:'chat',boardId:'board',recordId:'decision',purpose:'coordination',state:'blocked',code:'INPUT_REQUIRED',createdAt:1,lastActivityAt:4}]);
    const catalog=vi.fn(async()=>[{id:'board',title:'Board'}]),recordResources=vi.fn(async()=>[{reference:{system:'project',id:'p'},label:'Project'}]),execute=vi.fn();
    return {source:{records,recordConversations,catalog,recordResources,execute} as unknown as KanbanClient,records,recordConversations,catalog,recordResources,execute};
}
it('composes fresh page facts and metadata with one read of each independent source',async()=>{
    const f=fixture(),log=vi.fn();const snapshot=await decisionSnapshot(f.source,'board',{sections:['page','catalog','projects']},log);
    expect(snapshot.boards).toHaveLength(1);expect(snapshot.resources).toHaveLength(1);
    expect(snapshot.page.decisionRows[0]).toMatchObject({kind:'record',value:{id:'decision'},conversation:{id:'chat',code:'INPUT_REQUIRED'}});
    expect(snapshot.page.attentionTotal).toBe(1);expect(snapshot.page.conversationSignature).toMatch(/^[a-f0-9]{64}$/);
    for(const read of [f.records,f.recordConversations,f.catalog,f.recordResources])expect(read).toHaveBeenCalledOnce();
    expect(f.execute).not.toHaveBeenCalled();expect(log).toHaveBeenCalledWith(expect.objectContaining({stage:'decision.snapshot',result:'success',count:1}));
    await decisionSnapshot(f.source,'board');expect(f.records).toHaveBeenCalledTimes(2);expect(f.catalog).toHaveBeenCalledOnce();expect(f.recordResources).toHaveBeenCalledOnce();
});
it('starts records before a slow conversation source settles',async()=>{
    const f=fixture();let finish!:()=>void;
    f.recordConversations.mockImplementationOnce(()=>new Promise(resolve=>{finish=()=>resolve([]);}));
    const pending=decisionSnapshot(f.source,'board');expect(f.records).toHaveBeenCalledOnce();expect(f.recordConversations).toHaveBeenCalledOnce();
    finish();await pending;
});
it('retains main records and reports precise auxiliary failures without leaking error text',async()=>{
    const f=fixture(),log=vi.fn();f.recordConversations.mockRejectedValueOnce(Object.assign(Error('PRIVATE_CONTENT'),{code:'ENOENT'}));
    f.recordResources.mockRejectedValueOnce(Object.assign(Error('PRIVATE_TOKEN'),{code:'EACCES'}));
    const snapshot=await decisionSnapshot(f.source,'board',{sections:['page','catalog','projects']},log);
    expect(snapshot.page.items).toHaveLength(1);expect(snapshot.page.conversationCode).toBe('ENOENT');expect(snapshot.resourceCode).toBe('EACCES');
    expect(snapshot.resources).toBeUndefined();expect(snapshot.page.conversationSignature).toBeUndefined();
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE');expect(log).toHaveBeenCalledWith(expect.objectContaining({stage:'decision.snapshot.resources',code:'EACCES'}));
});
it('does not turn denied records into an empty successful page',async()=>{
    const f=fixture();f.records.mockRejectedValueOnce(Object.assign(Error('Denied'),{code:'EACCES'}));
    await expect(decisionSnapshot(f.source,'board')).rejects.toMatchObject({code:'EACCES'});expect(f.execute).not.toHaveBeenCalled();
});
it('paginates bounded metadata using a compact revision-bound cursor',async()=>{
    const f=fixture(Array.from({length:51},(_,i)=>record('d-'+String(i).padStart(3,'0'))));f.recordConversations.mockResolvedValue([]);
    const first=await decisionSnapshot(f.source,'board');expect(first.page.decisionRows).toHaveLength(50);expect(first.page.nextCursor!.length).toBeLessThan(150);
    const next=await decisionSnapshot(f.source,'board',{cursor:first.page.nextCursor});expect(next.page.decisionRows).toHaveLength(1);
    f.records.mockResolvedValueOnce({revision:4,total:51,items:Array.from({length:51},(_,i)=>record('d-'+i))});
    await expect(decisionSnapshot(f.source,'board',{cursor:first.page.nextCursor})).rejects.toMatchObject({code:'CURSOR_STALE'});
});
it('uses authorized resource names for project sorting and rejects an unavailable requested ordering',async()=>{
    const f=fixture([{...record('z'),externalRefs:[{system:'project',id:'z'}]},{...record('a'),externalRefs:[{system:'project',id:'p'}]}]);
    f.recordResources.mockResolvedValue([{reference:{system:'project',id:'z'},label:'Zoo'},{reference:{system:'project',id:'p'},label:'Alpha'}]);
    expect((await decisionSnapshot(f.source,'board',{sort:'project-asc',locale:'en'})).page.items.map(row=>row.id)).toEqual(['a','z']);
    expect(f.catalog).not.toHaveBeenCalled();f.recordResources.mockRejectedValueOnce(Object.assign(Error('Denied'),{code:'EACCES'}));
    await expect(decisionSnapshot(f.source,'board',{sort:'project-asc'})).rejects.toMatchObject({code:'EACCES'});
});

it('reads only explicitly requested sections and does not start page work for a catalog request',async()=>{
 const f=fixture();const result=await decisionSnapshot(f.source,'board',{sections:['catalog']});
 expect(result.boards).toHaveLength(1);expect(result.page).toBeUndefined();expect(result.resources).toBeUndefined();
 expect(f.catalog).toHaveBeenCalledOnce();expect(f.records).not.toHaveBeenCalled();expect(f.recordConversations).not.toHaveBeenCalled();expect(f.recordResources).not.toHaveBeenCalled();
 await decisionSnapshot(f.source,'board',{sections:[]});expect(f.catalog).toHaveBeenCalledOnce();
});

it('rejects malformed conditions before starting any source read',async()=>{
 const f=fixture();
 for(const query of [{sections:'page'},{sections:['unknown']},{archived:'false'},{cursor:3},{sort:'unknown'},{locale:'!invalid'},null]) {
  await expect(decisionSnapshot(f.source,'board',query as never)).rejects.toMatchObject({code:expect.stringMatching(/^INVALID_DECISION_/)});
 }
 expect(f.records).not.toHaveBeenCalled();expect(f.catalog).not.toHaveBeenCalled();expect(f.recordConversations).not.toHaveBeenCalled();expect(f.recordResources).not.toHaveBeenCalled();
});
