import {journalCommand} from './journal-command';
import type {KanbanFixSession} from '../contracts';
import type {KanbanExecutionPort} from '../execution';
import type {KanbanFixOptions,SavedFix} from './task-fix-ports';
import {requireValue} from '../rules';
import {safeCode} from './diagnostics';
export interface KanbanTaskFix<Instruction> {
    fixTask(board:string,request:{itemId:string;operationId:string}):Promise<KanbanFixSession>;
    taskFixes(board:string,item:string):Promise<KanbanFixSession[]>;
    cancelFix(board:string,request:{fixId:string;operationId:string}):Promise<KanbanFixSession>;
    intercept(session:string,input:Instruction):Promise<boolean>;
    scan():Promise<void>;
    quiesce():Promise<void>;
}
export function createTaskFix<Instruction>(options:KanbanFixOptions<Instruction>):KanbanTaskFix<Instruction> {return new TaskFix(options);}
/** Confirmation and admission use durable identities; Session observation cannot create another task. */
class TaskFix<Instruction> {
    private stopping=false;
    private readonly executor:KanbanExecutionPort;
    private readonly pending = new Map<string, Promise<unknown>>();
    private serial<T>(id: string, run: () => Promise<T>): Promise<T> {
        requireValue(!this.stopping,'SERVICE_STOPPING');
        const next = (this.pending.get(id) ?? Promise.resolve()).catch(() => {}).then(run);
        this.pending.set(id, next);
        void next.finally(() => {if (this.pending.get(id) === next) this.pending.delete(id);}).catch(() => {});
        return next;
    }
    constructor(private readonly options:KanbanFixOptions<Instruction>) {this.executor=options.executor;}
    private async prepare(fix:SavedFix):Promise<SavedFix> {
        if(fix.request)return fix;
        const work=await this.executor.prepare(fix.dispatch,fix.item);
        return this.options.journal.update<SavedFix>('fix:'+fix.id,old=>({...old!,request:old!.request??work}));
    }
    private async advance(fix:SavedFix):Promise<KanbanFixSession> {
        const {options}=this;
        fix = (await options.journal.get<SavedFix>('fix:' + fix.id))!;
        if (fix.state === 'cancelling') return this.stop(fix);
        if (fix.state === 'cancelled') return view(fix);
        if (fix.phase === 'prepared' && (await options.service.read(fix.boardId)).lifecycle) return view(fix);
        fix=await this.prepare(fix);
        if(fix.snapshot) {await options.accept(fix);return view((await options.journal.get<SavedFix>('fix:'+fix.id))!);}
        const claimed=await options.journal.claim('fix:'+fix.id);
        const observation=await (claimed?this.executor.start(fix.request):this.executor.inspect(fix.request));
        const sessionId=observation.executionSessionId??fix.sessionId;
        if(sessionId!==fix.id)await options.journal.update('fix-session:'+sessionId,old=>old??fix.id);
        const saved=await options.journal.update<SavedFix>('fix:'+fix.id,old=>({...old!,sessionId,code:observation.code}));
        await options.observe(saved);return view(saved);
    }
    fixTask=async(boardId:string,request:{itemId:string;operationId:string}):Promise<KanbanFixSession>=>{
        requireValue(!this.stopping,'SERVICE_STOPPING');
        const fix = await this.options.freeze(boardId,request); return this.serial(fix.id, () => this.advance(fix));
    };
    taskFixes = async (boardId: string, itemId: string): Promise<KanbanFixSession[]> => {
        await this.options.service.item(boardId, itemId);
        return (await this.options.journal.findForBoard<SavedFix>('fix:', boardId, fix => fix.itemId === itemId)).map(row => view(row.value));
    };
    cancelFix = async (boardId: string, request: {fixId: string; operationId: string}): Promise<KanbanFixSession> => this.serial(request.fixId, async () => {
        requireValue(/^[\w-]{1,128}$/.test(request.operationId), 'INVALID_OPERATION_ID');
        const board = await this.options.service.read(boardId), actor = await this.options.service.currentPrincipal();
        requireValue(actor.kind === 'human' && board.members?.some(m => m.kind === actor.kind && m.id === actor.id && m.roles?.includes('coordinator')), 'COORDINATOR_REQUIRED');
        const fix = await this.options.journal.update<SavedFix>('fix:' + request.fixId, old => {
            requireValue(old?.boardId === boardId, 'FIX_NOT_FOUND');
            requireValue(!old.accepted, 'FIX_ALREADY_ACCEPTED');
            return {...old, state: old.state === 'cancelled' ? 'cancelled' : 'cancelling', cancelOperationId: old.cancelOperationId ?? request.operationId};
        });
        return fix.state === 'cancelled' ? view(fix) : this.stop(fix);
    });
    private async stop(fix: SavedFix): Promise<KanbanFixSession> {
        const started = Date.now();
        try {
            let stopped = fix.phase === 'prepared' || fix.phase === 'settled';
            if (!stopped) stopped = await this.options.control.control({executionId:fix.id,operationId:fix.cancelOperationId!,action:'cancel'}) === 'cancelled';
            if (stopped && fix.snapshot) stopped = await this.stopCreatedTask(fix);
            const saved = await this.options.journal.update<SavedFix>('fix:' + fix.id, old => ({...old!, state: stopped ? 'cancelled' : 'cancelling', ...(stopped ? {phase: 'settled' as const} : {}), code: undefined}));
            this.options.log({operationId: fix.cancelOperationId!, boardId: fix.boardId, stage: 'fix.cancel', result: 'success', durationMs: Date.now() - started});
            return view(saved);
        } catch (error) {
            const code = safeCode(error, 'FIX_CANCEL_UNKNOWN');
            await this.options.journal.update<SavedFix>('fix:' + fix.id, old => ({...old!, code}));
            this.options.log({operationId: fix.cancelOperationId!, boardId: fix.boardId, stage: 'fix.cancel', result: 'failure', code, durationMs: Date.now() - started});
            throw error;
        }
    }
    private async stopCreatedTask(fix: SavedFix): Promise<boolean> {
        let item;
        try {item = (await this.options.service.item(fix.boardId, fix.snapshot!.operationId)).item;}
        catch (error) {if ((error as {code?: string}).code === 'ITEM_NOT_FOUND') return true; throw error;}
        if (['completed','cancelled'].includes(item.status)) return true;
        const controlId = 'fix-cancel-' + fix.id;
        await journalCommand(this.options.journal, this.options.service, fix.boardId, controlId,
            {type:'request-control', itemId:item.id, controlId, action:'cancel'});
        return false;
    }
    intercept=async(sessionId:string,input:Instruction):Promise<boolean>=>{
        const id=await this.options.journal.get<string>('fix-session:'+sessionId);if(!id)return false;
        return this.serial(id, async () => {
            const current = (await this.options.journal.get<SavedFix>('fix:' + id))!;
            requireValue(!['cancelling','cancelled'].includes(current.state), 'FIX_INPUT_CLOSED');
            return this.options.confirm(current,input);
        });
    };
    quiesce=async()=>{this.stopping=true;await Promise.allSettled([...this.pending.values()]);};
    scan=async()=>{
        for(const id of await this.options.journal.get<string[]>('fix-index')??[]) {
            if(this.stopping)return;
            const fix=await this.options.journal.get<SavedFix>('fix:'+id);if(!fix||fix.accepted||fix.state==='cancelled')continue;
            try {await this.serial(id, () => this.advance(fix));} catch(error) {this.options.log({operationId:id,boardId:fix.boardId,stage:'fix.recover',result:'failure',code:safeCode(error,'FIX_RECOVERY_FAILED'),durationMs:0});}
        }
    };
}
function view(fix:SavedFix):KanbanFixSession {const {id,boardId,itemId,sessionId,state,createdItemId,code}=fix;return {id,boardId,itemId,sessionId,state,createdItemId,code};}
