import {expect,it} from 'vitest';
import {requireOperationAuthority as enforceOperationAuthority} from '@nestos/kanban/integration';
import type {OperationAuthorityContext as ReviewContext,OperationAuthorityPorts as ReviewOperationsOptions} from '../src/runtime/item-operation-authority';
const policy={confirmationActions:['deploy','merge'],followUpActions:{build:'deploy'},acceptanceAction:'accept',canonicalSteps:['build','deploy','accept','analyze','merge','cleanup']};
const requireOperationAuthority=(options:Omit<ReviewOperationsOptions,keyof typeof policy>,...args:Parameters<typeof enforceOperationAuthority> extends [unknown,...infer Rest]?Rest:never)=>enforceOperationAuthority({...options,...policy},...args);
type ReviewJob=ReviewContext['jobs'][number];
const context=()=>({board:{id:'board'},item:{id:'item'},jobs:[],deliveryPlan:{ordering:'configured',steps:['analyze','merge','accept','cleanup'],acceptance:'source'}} as ReviewContext);
const request=()=>({operationId:'operation',itemId:'item',action:'merge',expectedRevision:'revision'});
it('does not let a confirmation flag grant automatic authority',async()=>{
 const options={automatic:async()=>false,log(){}} as ReviewOperationsOptions;
 await expect(requireOperationAuthority(options,context(),{...request(),confirmed:true},'automatic')).rejects.toMatchObject({code:'OPERATION_CONFIRMATION_REQUIRED'});
});
it('uses host policy without manufacturing a user confirmation',async()=>{
 await expect(requireOperationAuthority({automatic:async()=>true,log(){}} as ReviewOperationsOptions,context(),request(),'automatic')).resolves.toBeUndefined();
});
it('enforces a decision-reserved manual boundary independently of automatic scheduling',async()=>{
 const value=context();value.deliveryPlan!.manualAfter='analyze';
 await expect(requireOperationAuthority({automatic:async()=>true,log(){}} as ReviewOperationsOptions,value,request(),'automatic')).rejects.toMatchObject({code:'OPERATION_CONFIRMATION_REQUIRED'});
});
it('requires the exact durable build follow-up request and rejects a modified deployment',async()=>{
 const value=context(),input={...request(),action:'deploy'};
 value.jobs=[{id:'build',action:'build',phase:'settled',state:'succeeded',followUp:{action:'deploy',state:'queued',request:input}} as ReviewJob];
 await expect(requireOperationAuthority({log(){}} as ReviewOperationsOptions,value,input,{followUp:'build'})).resolves.toBeUndefined();
 await expect(requireOperationAuthority({log(){}} as ReviewOperationsOptions,value,{...input,operationId:'other',confirmed:true},{followUp:'build'})).rejects.toMatchObject({code:'OPERATION_CONFIRMATION_REQUIRED'});
});
it('retains explicit confirmation for an interactive operation',async()=>{
 await expect(requireOperationAuthority({log(){}} as ReviewOperationsOptions,context(),request(),'manual')).rejects.toMatchObject({code:'OPERATION_CONFIRMATION_REQUIRED'});
});
it('honors a reserved manual boundary even for a previously queued follow-up',async()=>{
 const value=context(),input={...request(),action:'deploy'};
 value.deliveryPlan={steps:['build','deploy'],manualAfter:'build',acceptance:'runtime'};
 value.jobs=[{id:'build',action:'build',phase:'settled',state:'succeeded',followUp:{action:'deploy',state:'queued',request:input}} as ReviewJob];
 await expect(requireOperationAuthority({log(){}} as ReviewOperationsOptions,value,input,{followUp:'build'})).rejects.toMatchObject({code:'OPERATION_CONFIRMATION_REQUIRED'});
});
