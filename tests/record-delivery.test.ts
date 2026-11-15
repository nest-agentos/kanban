import {afterEach,expect,it} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule,SeqKanbanStore} from '../src';
import {recordFingerprint} from '../src/project-records';
import {kanbanVerificationMode} from '../src/contracts';
const closes:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of closes.splice(0))await close();});
async function fixture(){
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());
 const service=createKanbanModule({store:await SeqKanbanStore.open(await manager.openFileSystem('/')),actor:{kind:'human',id:'owner'},authorize:async()=>{}});
 await service.create({id:'board',title:'Board',scope:{kind:'system'},members:[{kind:'human',id:'owner',roles:['coordinator'],responsibility:'Manage'}]});
 let operation=0;const run=async(command:any)=>service.execute('board',{operationId:'operation-'+ ++operation,expectedRevision:(await service.read('board')).revision,command});
 await run({type:'append-record',record:{id:'decision',kind:'decision',title:'Decision',content:'Scope',rationale:'Verify',itemIds:[],sources:[],verificationLevel:'none',deliveryMode:'build'}});
 await run({type:'review-record',recordId:'decision',accept:true});return {service,run};
}
it('changes delivery on a confirmed decision without cancelling it, rewriting the original plan or changing execution identity',async()=>{
 const f=await fixture(),before=await f.service.record('board','decision'),signature=recordFingerprint(before);
 await f.run({type:'configure-record-delivery',recordId:'decision',expectedRecordRevision:before.revision,verificationLevel:'none',deliveryMode:'release'});
 const record=await f.service.record('board','decision');expect(record).toMatchObject({status:'confirmed',deliveryMode:'build',deliveryOptions:{verificationLevel:'none',deliveryMode:'release',revision:before.revision+1}});
 expect(kanbanVerificationMode(record)).toBe('release');expect(recordFingerprint(record)).toBe(signature);expect(record.itemIds).toEqual(before.itemIds);
 await expect(f.run({type:'configure-record-delivery',recordId:'decision',expectedRecordRevision:before.revision,verificationLevel:'none',deliveryMode:'source'})).rejects.toMatchObject({code:'RECORD_DELIVERY_CHANGED'});
});
it('rejects invalid modes and verification escalation that would require new execution planning',async()=>{
 const f=await fixture(),before=await f.service.record('board','decision');
 await expect(f.run({type:'configure-record-delivery',recordId:'decision',expectedRecordRevision:before.revision,verificationLevel:'full',deliveryMode:'source'})).rejects.toMatchObject({code:'INVALID_VERIFICATION_MODE'});
 await f.run({type:'create-item',item:{id:'task',title:'Task',responsibility:'Work',acceptance:'Done'}});await f.run({type:'link-record',recordId:'decision',itemId:'task'});
 const linked=await f.service.record('board','decision');await expect(f.run({type:'configure-record-delivery',recordId:'decision',expectedRecordRevision:linked.revision,verificationLevel:'full',deliveryMode:'release'})).rejects.toMatchObject({code:'DELIVERY_VERIFICATION_REPLAN_REQUIRED'});
 expect((await f.service.record('board','decision')).deliveryOptions).toBeUndefined();
});
