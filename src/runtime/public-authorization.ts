import type {KanbanExternalReference} from '../contracts';
import type {KanbanModuleOptions} from '../ports';
import type {KanbanRuntimeOptions} from './public-ports';
import {requireValue} from '../rules';
/** Catalog validation complements the host's current principal/resource authorization. */
export function runtimeAuthorization(options:KanbanRuntimeOptions):KanbanModuleOptions['authorize'] {
    return async input=>{
        await options.authorize(input);
        const command=input.command;if(command?.type!=='configure-automation')return;
        if(!options.execution){requireValue(!command.settings.enabled,'AUTOMATION_UNAVAILABLE');return;}
        const catalog=await options.execution.catalog(),settings=command.settings;
        for(const reference of [settings.planner,settings.executor])requireValue(catalog.targets.some(target=>sameReference(target.reference,reference)),'AUTOMATION_TARGET_CHANGED');
        if(settings.preparation)requireValue(catalog.preparations?.some(target=>sameReference(target.reference,settings.preparation!)),'PREPARATION_UNAVAILABLE');
        requireValue(settings.coordinator.kind===catalog.coordinator.kind&&settings.coordinator.id===catalog.coordinator.id
            &&settings.worker.kind===catalog.worker.kind&&settings.worker.id===catalog.worker.id,'AUTOMATION_PRINCIPAL_CHANGED');
    };
}
function sameReference(left:KanbanExternalReference,right:KanbanExternalReference):boolean {
    return left.system===right.system&&left.id===right.id&&left.revision===right.revision;
}
