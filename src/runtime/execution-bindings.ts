import type {KanbanExecutionHandle,KanbanExecutionIntent} from './public-ports';
import type {KanbanAutomationJournal} from './automation-journal';
import {requireValue} from '../rules';
interface Binding {scope:KanbanExecutionIntent['scope'];handle:KanbanExecutionHandle}
/** Stable intent identities are the only index used by control and recovery. */
export class ExecutionBindings {
    constructor(private readonly journal:KanbanAutomationJournal) {}
    async save(intent:KanbanExecutionIntent,handle:KanbanExecutionHandle):Promise<KanbanExecutionHandle> {
        requireValue(typeof handle?.id==='string'&&handle.id.length>0&&handle.id.length<=512,'EXECUTION_HANDLE_INVALID');
        const next:Binding={scope:intent.scope,handle},encoded=JSON.stringify(next);
        requireValue(new TextEncoder().encode(encoded).byteLength<=128*1024,'EXECUTION_HANDLE_TOO_LARGE');
        const saved=await this.journal.update<Binding>('execution-binding:'+intent.id,old=>{
            requireValue(!old||JSON.stringify(old)===encoded,'EXECUTION_BINDING_CONFLICT');return old??next;
        });
        return saved.handle;
    }
    async get(id:string):Promise<KanbanExecutionHandle|undefined> {
        return (await this.journal.get<Binding>('execution-binding:'+id))?.handle;
    }
}
