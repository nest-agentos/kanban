import {expect,it} from 'vitest';
import {compareDecisionRows} from '../src/contracts';
import {compareSegmentedIdentifiers} from '../src/contracts/decision-sort';
const record=(id:string,number:number,title:string)=>({kind:'record',value:{id,number,title,createdAt:1,updatedAt:1,status:'confirmed'}} as any);
const draft=(id:string,title:string)=>({kind:'conversation',value:{id,title,createdAt:1,state:'draft',sessionId:'native'}} as any);
it('compares every ID segment as an integer rather than a decimal or string',()=>{
 const values=['KBD-10-1','KBD-2-10','KBD-2-2','KBD-2-1-10','KBD-2-1-2'];
 expect(values.sort((a,b)=>compareSegmentedIdentifiers(a,b))).toEqual(['KBD-2-1-2','KBD-2-1-10','KBD-2-2','KBD-2-10','KBD-10-1']);
 expect(compareSegmentedIdentifiers('KBD-02-0010','KBD-2-10')).toBe(0);
 expect(compareSegmentedIdentifiers('KBD-1-9007199254740993','KBD-1-9007199254740992')).toBeGreaterThan(0);
});
it.each(['title-asc','title-desc'] as const)('keeps drafts first and compares the displayed record number for %s',sort=>{
 const rows=[record('a',10,'Alpha'),draft('internal-conversation-id','Zulu draft'),record('z',2,'Zulu')];
 expect(rows.sort((a,b)=>compareDecisionRows(a,b,sort)).map(row=>row.value.id)).toEqual(sort==='title-asc'?['internal-conversation-id','z','a']:['internal-conversation-id','a','z']);
});
it('does not treat a saved decision with a formal number as an unnumbered conversation draft',()=>{
 const numbered={...record('saved',10,'Alpha'),value:{...record('saved',10,'Alpha').value,status:'draft'}};
 const rows=[numbered,record('approved',2,'Zulu'),draft('chat','Discussion')];
 expect(rows.sort((a,b)=>compareDecisionRows(a,b,'title-asc')).map(row=>row.value.id)).toEqual(['chat','approved','saved']);
});
