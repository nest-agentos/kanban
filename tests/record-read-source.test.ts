import {currentGroupProgress} from '../src/runtime/record-progress-groups';
import {expect,it,vi} from 'vitest';
import {recordReadSource} from '../src/runtime/record-read-source';
function fixture() {
 const item=(id:string)=>({id,title:id,status:'claimed',createdAt:1,updatedAt:2,planning:{priority:1},sessionIds:[],externalRefs:[],task:{phase:'running',actions:[]}});
 const query=vi.fn(async(_board:string,input:any)=>({revision:1,total:(input.ids??[]).length,items:(input.ids??[]).map(item)}));
 const service={query} as never,log=vi.fn(),options={log} as never;
 return {service,query,log,options,reader:recordReadSource(service,options)};
}
it('uses one authorized task read for overlapping progress and activity requests and reads only missing identities',async()=>{
 const f=fixture();await f.reader.query('b',{ids:['a','b'],view:'all',includeDeleted:true,limit:200});
 expect((await f.reader.queryActivity('b',{ids:['a'],view:'all',limit:200})).items.map(row=>row.id)).toEqual(['a']);expect(f.query).toHaveBeenCalledOnce();
 await f.reader.queryActivity('b',{ids:['b','c'],view:'all',limit:200});expect(f.query).toHaveBeenCalledTimes(2);expect(f.query.mock.calls[1][1].ids).toEqual(['c']);
 expect(f.log).toHaveBeenCalledWith(expect.objectContaining({stage:'record.items.storage',count:0,readCount:0}));
 const other=recordReadSource(f.service,f.options);await other.query('b',{ids:['a'],view:'all',limit:200});expect(f.query).toHaveBeenCalledTimes(3);
});
it('keeps deleted filtering, source ordering and caller filters and rejects mixed revisions',async()=>{
 const f=fixture();f.query.mockResolvedValueOnce({revision:1,total:2,items:[{id:'a',planning:{priority:2},createdAt:1,deletedAt:5},{id:'b',planning:{priority:1},createdAt:1}]} as never);
 await f.reader.query('b',{ids:['a','b'],includeDeleted:true,view:'all',limit:200});
 expect((await f.reader.queryActivity('b',{ids:['a','b'],view:'all',limit:200})).items.map(row=>row.id)).toEqual(['b']);
 await f.reader.query('b',{view:'all',search:'specific',limit:200});expect(f.query).toHaveBeenCalledTimes(2);
 f.query.mockResolvedValueOnce({revision:2,total:0,items:[]} as never);
 await expect(f.reader.queryActivity('b',{ids:['c'],view:'all',limit:200})).rejects.toMatchObject({code:'CURSOR_STALE'});
});

it('starts independent board reads before a slow board resolves',async()=>{
 let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
 const records=['one','two'].map(id=>({id,status:'confirmed',itemIds:['old'],kind:'decision',createdAt:1,updatedAt:1})),runs=new Map(records.map((row,index)=>[row.id,{id:'run-'+row.id,recordId:row.id,boardId:index?'fast':'slow',itemIds:['new'],createdAt:1,updatedAt:1}]));
 const query=vi.fn(async(board:string)=>{if(board==='slow')await held;return {revision:1,total:0,items:[]};});
 const pending=currentGroupProgress(records as any,runs as any,'source',{query} as any);
 try{await vi.waitFor(()=>expect(query).toHaveBeenCalledTimes(2));}finally{release();await pending;}
});
