import {runtimeLogger} from './logging';
import {sha256HexSync} from '../utils';
import type {KanbanBoard, KanbanDeletionRequest} from '../contracts';
import type {Options} from './board-deletion-inspection';
import {deletionPreview} from './board-deletion-inspection';
import {journalCommand} from './journal-command';
import {requireValue} from '../rules';
import {safeCode} from './diagnostics';
type Lifecycle = NonNullable<KanbanBoard['lifecycle']>;
interface Request {operationId:string;expectedRevision:number;cleanup?:boolean;mode?:'drain'|'cancel';version?:string}
interface Saved {boardId:string;principalId:string;intent:Lifecycle['intent'];request:Request;phase:'prepared'|'admitted'|'done'}
const keyFor = (board:string) => 'board-stop:' + board;
export function createBoardStop(options: Options, remove: (board:string,request:KanbanDeletionRequest)=>Promise<void>) {
    const log = runtimeLogger(options.journal);
    return {
        cancelBoard: (board:string,request:{operationId:string;expectedRevision:number}) => requestStop(options,board,{...request,mode:'cancel'},'cancel'),
        requestBoardDeletion: (board:string,request:KanbanDeletionRequest & {mode:'drain'|'cancel'}) => requestStop(options,board,request,'delete'),
        preparePending: async () => {
            for (const row of await pending(options)) {
                const started=Date.now();
                try {await admit(options,row.value);} catch(error) {log.warn('Board stop admission pending',{operation:'kanban.board.stop',operationId:row.value.request.operationId,boardId:row.value.boardId,stage:'admit',result:'failure',code:safeCode(error,'BOARD_STOP_ADMISSION_UNKNOWN'),durationMs:Date.now()-started});}
            }
        },
        resumePending: async () => {
            for (const row of await pending(options)) {
                const started=Date.now(), saved=row.value;
                try {
                    if ((await options.service.read(saved.boardId)).deletedAt !== undefined) {await done(options,saved);continue;}
                    if ((await authorize(options,saved)).lifecycle?.operationId !== saved.request.operationId) continue;
                    const preview=await deletionPreview(options,saved.boardId);
                    if (preview.blockers.length) {await progress(options,saved,'blocked',preview.blockers[0].code);continue;}
                    await progress(options,saved,'ready');
                    if (saved.intent === 'cancel') {await done(options,saved);continue;}
                    const current=await deletionPreview(options,saved.boardId);
                    await remove(saved.boardId,{operationId:sha256HexSync(JSON.stringify([saved.request.operationId,current.version])),expectedRevision:current.revision,version:current.version,cleanup:saved.request.cleanup===true});
                    await done(options,saved);
                    log.info('Deferred board deletion completed',{operation:'kanban.board.stop',operationId:saved.request.operationId,boardId:saved.boardId,stage:'delete',result:'success',durationMs:Date.now()-started});
                } catch(error) {
                    const code=safeCode(error,'BOARD_DELETION_UNKNOWN');
                    await progress(options,saved,'blocked',code).catch(()=>{});
                    log.warn('Deferred board deletion pending',{operation:'kanban.board.stop',operationId:saved.request.operationId,boardId:saved.boardId,stage:'settle',result:'failure',code,durationMs:Date.now()-started});
                }
            }
        },
    };
}
function pending({journal}:Options) {return journal.find<Saved>('board-stop:',value=>value.phase!=='done');}
async function authorize(options:Options,saved:Pick<Saved,'boardId'|'principalId'>):Promise<KanbanBoard> {
    const board=await options.service.read(saved.boardId),actor=await options.service.currentPrincipal();
    requireValue(actor.kind==='human'&&actor.id===saved.principalId&&board.members?.some(member=>member.kind===actor.kind&&member.id===actor.id&&member.roles?.includes('coordinator')),'COORDINATOR_REQUIRED');
    return board;
}
async function requestStop(options:Options,boardId:string,request:Request,intent:Lifecycle['intent']):Promise<void> {
    requireValue(/^[\w-]{1,128}$/.test(request.operationId) && Number.isSafeInteger(request.expectedRevision),'INVALID_OPERATION_ID');
    if (intent === 'delete') requireValue(typeof request.cleanup === 'boolean' && ['drain','cancel'].includes(request.mode ?? '') && /^[a-f0-9]{64}$/.test(request.version ?? ''),'INVALID_BOARD_CONTROL');
    const actor=await options.service.currentPrincipal(),board=await authorize(options,{boardId,principalId:actor.id});
    const old=await options.journal.get<Saved>(keyFor(boardId));
    if (old?.request.operationId===request.operationId) {requireValue(old.intent===intent&&JSON.stringify(old.request)===JSON.stringify(request),'IDEMPOTENCY_CONFLICT');if(old.phase!=='done')await admit(options,old);return;}
    requireValue(board.deletedAt===undefined,'BOARD_DELETED');
    requireValue(!old||old.intent==='cancel'&&intent==='delete','BOARD_STOP_PENDING');
    requireValue(board.revision===request.expectedRevision,'REVISION_CONFLICT');
    if(intent==='delete'){const preview=await deletionPreview(options,boardId);requireValue(preview.version===request.version,'BOARD_DELETE_PREVIEW_CHANGED');}
    const saved=await options.journal.update<Saved>(keyFor(boardId),current=>{
        requireValue(!current||current.request.operationId===old?.request.operationId,'BOARD_STOP_PENDING');
        return {boardId,principalId:actor.id,intent,request:structuredClone(request),phase:'prepared'};
    });
    await admit(options,saved);
}
async function admit(options:Options,saved:Saved):Promise<void> {
    if(saved.phase!=='prepared')return;
    const board=await authorize(options,saved);
    if(board.deletedAt!==undefined){await done(options,saved);return;}
    await journalCommand(options.journal,options.service,saved.boardId,'board-stop-admit:'+JSON.stringify([saved.boardId,saved.request.operationId]),
        {type:'request-board-stop',controlId:saved.request.operationId,intent:saved.intent,mode:saved.request.mode??'cancel'});
    await options.journal.update<Saved>(keyFor(saved.boardId),old=>old?.request.operationId === saved.request.operationId ? {...old,phase:'admitted'} : old!);
}
async function progress(options:Options,saved:Saved,phase:Lifecycle['phase'],code?:string):Promise<void> {
    const board=await authorize(options,saved);
    if(board.deletedAt!==undefined||board.lifecycle?.operationId!==saved.request.operationId||board.lifecycle?.phase===phase&&board.lifecycle.code===code)return;
    await journalCommand(options.journal,options.service,saved.boardId,'board-stop-progress:'+JSON.stringify([saved.boardId,saved.request.operationId,board.revision,phase,code??'']),
        {type:'observe-board-stop',controlId:saved.request.operationId,phase,code});
}
async function done(options:Options,saved:Saved) {await options.journal.update<Saved>(keyFor(saved.boardId),old=>old?.request.operationId === saved.request.operationId ? {...old,phase:'done'} : old!);}
