import {expect,it,vi} from 'vitest';
import {validateDecisionDependencies,decisionDependencyStates} from '../src/runtime/record-dependencies';
it('rejects a cross-board cycle and refuses unavailable prerequisites',async()=>{
 const record=vi.fn(async(board:string,id:string)=>({id,title:id,kind:'decision',status:'confirmed',dependsOn:[{boardId:board==='a'?'b':'a',recordId:id==='one'?'two':'one'}]}));
 await expect(validateDecisionDependencies({record} as never,'a','one',[{boardId:'b',recordId:'two'}])).rejects.toMatchObject({code:'DECISION_DEPENDENCY_CYCLE'});
 record.mockResolvedValue({id:'two',title:'Two',kind:'decision',status:'cancelled',dependsOn:[]} as never);
 await expect(validateDecisionDependencies({record} as never,'a','one',[{boardId:'b',recordId:'two'}])).rejects.toMatchObject({code:'DECISION_DEPENDENCY_UNAVAILABLE'});
});
it('batches prerequisite reads and waits for formal finalization even after task completion',async()=>{
 const read=vi.fn(async()=>[{id:'server',title:'Server',kind:'decision',status:'confirmed',progress:{state:'completed',followUps:[{state:'blocked'}]}},{id:'done',title:'Done',kind:'decision',status:'confirmed',progress:{state:'completed'}}]);
 const states=await decisionDependencyStates([{boardId:'b',recordId:'server'},{boardId:'b',recordId:'done'}],read as never);
 expect(states.map(row=>row.state)).toEqual(['waiting','completed']);expect(read).toHaveBeenCalledOnce();
});
