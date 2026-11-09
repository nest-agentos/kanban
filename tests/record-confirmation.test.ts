import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule,SeqKanbanStore} from '../src';
import {KanbanAutomationJournal,confirmRecordExecution,advanceRecordCancellation,journalCommand} from '../src/runtime/integration';
const cleanup:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
async function fixture(){
    const {manager}=await createVFS({rootBackend:new MemoryBackend()});cleanup.push(()=>manager.dispose());const fs=await manager.openFileSystem('/'),journal=new KanbanAutomationJournal(fs);await journal.open();
    const actor={kind:'human' as const,id:'owner'},service=createKanbanModule({store:await SeqKanbanStore.open(fs),actor,authorize:async()=>{},log(){}});
    const board=await service.create({id:'b',title:'Research',scope:{kind:'system'},members:[{...actor,responsibility:'Review',roles:['coordinator','reviewer','worker']}]});
    await service.execute('b',{operationId:'seed',expectedRevision:board.revision,command:{type:'append-record',record:{id:'decision',kind:'decision',title:'Research',content:'Study',rationale:'Review evidence',itemIds:[],sources:[]}}});
    const commit=vi.fn(async(command:any)=>journalCommand(journal,service,'b','confirmation-command',command));
    const run=vi.fn(async(_request:any)=>({state:'running'} as never)),confirmed=vi.fn(async()=>{});
    const input={boardId:'b',recordId:'decision',runKey:'old-run-key',runOperationId:'original-run',active:()=>true,commit,confirmed,run};return {service,journal,input,commit,run};
}
it('keeps record confirmation and run admission identities across an unknown run reply',async()=>{
    const f=await fixture();f.run.mockRejectedValueOnce(Object.assign(Error('Reply lost'),{code:'ECONNRESET'}));await expect(confirmRecordExecution(f.service,f.journal,f.input)).rejects.toMatchObject({code:'ECONNRESET'});
    expect((await f.service.record('b','decision')).status).toBe('confirmed');await confirmRecordExecution(f.service,f.journal,f.input);
    expect(f.commit).toHaveBeenCalledOnce();expect(f.run.mock.calls[1]).toEqual(f.run.mock.calls[0]);
    await expect(confirmRecordExecution(f.service,f.journal,{...f.input,runOperationId:'replacement'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
});
it('stops admission before confirmation when quiescing',async()=>{
    const f=await fixture();await expect(confirmRecordExecution(f.service,f.journal,{...f.input,active:()=>false})).rejects.toMatchObject({code:'SERVICE_STOPPING'});expect(f.commit).not.toHaveBeenCalled();expect(f.run).not.toHaveBeenCalled();
});
it('reconciles cancellation through the original domain control without manufacturing success',async()=>{
    const f=await fixture();await confirmRecordExecution(f.service,f.journal,f.input);
    const controlRecord=vi.fn(async()=>{});Object.assign(f.service,{controlRecord});
    await expect(advanceRecordCancellation(f.service,'b','decision','cancel')).rejects.toMatchObject({code:'DECISION_CANCELLATION_UNCONFIRMED'});
    controlRecord.mockImplementation(async()=>{await journalCommand(f.journal,f.service,'b','cancel-command',{type:'request-record-cancellation',recordId:'decision'});});
    await advanceRecordCancellation(f.service,'b','decision','cancel');await advanceRecordCancellation(f.service,'b','decision','cancel');expect(controlRecord).toHaveBeenCalledTimes(2);
});
