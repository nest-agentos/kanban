import {expect,it,vi} from 'vitest';
import {adoptDecomposition,validateSubtasks} from '../src/runtime/analysis-decomposition';
it('preserves an opaque host profile per child without inheriting unrelated resources',async()=>{
 const ref={system:'external-delivery',id:'source',revision:'1'},project={system:'project',id:'one'};
 const subtasks=[{key:'a',title:'A',responsibility:'A',acceptance:'A',dependsOn:[],executionProfile:ref},{key:'b',title:'B',responsibility:'B',acceptance:'B',dependsOn:['a']}];
 expect(validateSubtasks(subtasks)).toEqual(subtasks);
 const execute=vi.fn(async()=>{}),journal={update:vi.fn(async(_key,change)=>change(undefined))};
 await adoptDecomposition(journal as any,{id:'board',revision:1,policy:{requireEstimate:false},automation:{worker:{kind:'service',id:'worker'}}} as any,{id:'parent',planning:{kind:'task'}} as any,{id:'analysis',reason:'Split',dependencies:[],subtasks}, {execute} as any,[project]);
 const items=(execute.mock.calls[0] as any)[1].command.plan.items;
 expect(items[0].externalRefs).toEqual([project,ref]);expect(items[1].externalRefs).toEqual([project]);
 expect(()=>validateSubtasks([{...subtasks[0],executionProfile:{system:'external',id:'',revision:'1'}},subtasks[1]])).toThrowError(expect.objectContaining({code:'AUTOMATION_EXECUTION_PROFILE_INVALID'}));
});
it('admits one implementation child without requiring a redundant verifier',()=>{
 const tasks=[{key:'implementation',title:'Implement',responsibility:'Build',acceptance:'Selected checks',dependsOn:[],executionProfile:{system:'external-delivery',id:'source',revision:'1'}}];
 expect(validateSubtasks(tasks)).toEqual(tasks);
 expect(()=>validateSubtasks([])).toThrowError(expect.objectContaining({code:'AUTOMATION_SUBTASKS_INVALID'}));
});
