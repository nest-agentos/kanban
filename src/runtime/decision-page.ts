import type {KanbanClient,KanbanDecisionQuery,KanbanDecisionSnapshot,KanbanDecisionRow,KanbanRecordConversation,KanbanRecordResource} from '../contracts';
import {DEFAULT_DECISION_SORT,compareDecisionRows,decisionRowState,decisionSorts,decisionFilterStates,DECISION_SEARCH_LIMIT,decisionRows as composeRows,decisionRecordsQuery,decisionPageFilter} from '../contracts';
import {sha256HexSync,randomUUID} from '../utils';
import {KanbanError} from '../ports';
import type {KanbanRuntimeOptions} from './runtime-ports';
type Log=(event:Parameters<NonNullable<KanbanRuntimeOptions['log']>>[0]&{count?:number})=>void;
import {safeCode} from './diagnostics';

/** Compose authorized domain reads for one page; no cross-request results are retained. */
export async function decisionSnapshot(service:KanbanClient,board:string,query:KanbanDecisionQuery={},log:Log=()=>{}):Promise<KanbanDecisionSnapshot> {
    const operationId=randomUUID(),started=Date.now();
    try {
        validateQuery(query);
        const sections=new Set(query.sections??['page']);
        const [records,conversations,boards,resources]=await readSources(service,board,query,sections);
        if(records.status==='rejected')throw records.reason;
        if(boards.status==='rejected')throw boards.reason;
        if(records.value?.nextCursor)throw new KanbanError('DECISION_RECORD_PAGE_INCOMPLETE');
        const conversationCode=conversations.status==='rejected'?safeCode(conversations.reason,'DECISION_CONVERSATIONS_READ_FAILED'):undefined;
        const resourceCode=resources.status==='rejected'?safeCode(resources.reason,'RESOURCE_CATALOG_FAILED'):undefined;
        for(const [stage,code] of [['conversations',conversationCode],['resources',resourceCode]])if(code)log({operationId,boardId:board,stage:'decision.snapshot.'+stage,result:'failure',code,durationMs:Date.now()-started});
        if(query.sort?.startsWith('project-')&&resources.status==='rejected')throw resources.reason;
        const rows=conversations.status==='fulfilled'?conversations.value:[],catalog=resources.status==='fulfilled'?resources.value:undefined;
        const page=records.value?composePage(records.value,rows,board,query,catalog,conversationCode):undefined;
        log({operationId,boardId:board,stage:'decision.snapshot',result:'success',count:page?.decisionRows.length??0,durationMs:Date.now()-started});
        return {page:page&&{...page,dismissAvailable:!!service.controlRecord,dismissConversationAvailable:!!service.controlRecordConversation},boards:boards.value,resources:sections.has('projects')?catalog:undefined,resourceCode,observedAt:Date.now()};
    }catch(error){log({operationId,boardId:board,stage:'decision.snapshot',result:'failure',code:safeCode(error,'DECISION_SNAPSHOT_FAILED'),durationMs:Date.now()-started});throw error;}
}
function validateQuery(query:KanbanDecisionQuery):void {
    if(!query||typeof query!=='object'||Array.isArray(query))throw new KanbanError('INVALID_DECISION_QUERY');
    if(query.sort!==undefined&&!decisionSorts.includes(query.sort)||query.cursor!==undefined&&(typeof query.cursor!=='string'||query.cursor.length>1024))throw new KanbanError('INVALID_DECISION_QUERY');
    if(query.sections!==undefined&&(!Array.isArray(query.sections)||query.sections.some(section=>!['page','catalog','projects'].includes(section))))throw new KanbanError('INVALID_DECISION_SECTIONS');
    if([query.archived,query.includeArchived,query.attentionOnly,query.recurring].some(value=>value!==undefined&&typeof value!=='boolean'))throw new KanbanError('INVALID_DECISION_QUERY');
    if(query.resource&&(!query.resource.system||!query.resource.id||typeof query.resource.system!=='string'||typeof query.resource.id!=='string'))throw new KanbanError('INVALID_DECISION_QUERY');
    validateFilters(query);
    try{if(query.locale!==undefined)new Intl.Collator(query.locale,{numeric:true,sensitivity:'base'});}catch{throw new KanbanError('INVALID_DECISION_LOCALE');}
}
function validateFilters(query:KanbanDecisionQuery):void {
    if(query.search!==undefined&&(typeof query.search!=='string'||query.search.length>DECISION_SEARCH_LIMIT))
        throw new KanbanError('INVALID_DECISION_QUERY');
    if(query.states!==undefined&&(!Array.isArray(query.states)||query.states.length>decisionFilterStates.length||query.states.some(state=>!decisionFilterStates.includes(state))))
        throw new KanbanError('INVALID_DECISION_QUERY');
    if(query.resources!==undefined&&(!Array.isArray(query.resources)||query.resources.length>100||
        query.resources.some(ref=>!ref||typeof ref.system!=='string'||!ref.system||typeof ref.id!=='string'||!ref.id)))
        throw new KanbanError('INVALID_DECISION_QUERY');
}
function readSources(service:KanbanClient,board:string,query:KanbanDecisionQuery,sections:Set<string>) {
    const pageNeeded=sections.has('page');
    const resourcesNeeded=sections.has('projects')||pageNeeded&&query.sort?.startsWith('project-');
    return Promise.allSettled([
        pageNeeded?service.records(board,decisionRecordsQuery(query)):Promise.resolve(undefined),
        pageNeeded?service.recordConversations?.(board)??Promise.resolve([]):Promise.resolve([]),
        sections.has('catalog')?service.catalog():Promise.resolve(undefined),
        resourcesNeeded?service.recordResources?.()??Promise.resolve([]):Promise.resolve(undefined),
    ] as const);
}
function composePage(records:Awaited<ReturnType<KanbanClient['records']>>,conversations:KanbanRecordConversation[],boardId:string,query:KanbanDecisionQuery,resources?:KanbanRecordResource[],conversationCode?:string) {
    const rows=composeRows(records.items,conversations,query);
    const sort=query.sort??DEFAULT_DECISION_SORT;
    let collator: Intl.Collator|undefined;
    try{collator=query.locale?new Intl.Collator(query.locale,{numeric:true,sensitivity:'base'}):undefined;}catch{throw new KanbanError('INVALID_DECISION_LOCALE');}
    rows.sort((a,b)=>compareDecisionRows(a,b,sort,row=>projectLabel(row,resources),collator));
    const {attentionTotal,visible}=decisionPageFilter(rows,query);
    const scope={boardId,recurring:query.recurring??false,locale:query.locale??null,resource:query.resource??null,search:query.search??'',resources:query.resources??[],states:query.states??[],includeArchived:!!query.includeArchived,sort,attentionOnly:!!query.attentionOnly,archived:!!query.archived,revision:records.revision,
        rows:rows.map(row=>[row.kind,row.value.id,decisionRowState(row).state,row.value.createdAt,decisionRowState(row).lastActivityAt,row.kind==='record'?row.value.archivedAt:null]),projects:sort.startsWith('project-')?rows.map(row=>projectLabel(row,resources)):undefined};
    const fingerprint=sha256HexSync(JSON.stringify(scope)),offset=cursorOffset(query.cursor,fingerprint);
    const decisionRows=visible.slice(offset,offset+50),items=decisionRows.flatMap(row=>row.kind==='record'?[row.value]:[]);
    return {revision:records.revision,total:visible.length,items,decisionRows,attentionTotal,conversationCode,
        conversationSignature:conversationCode?undefined:sha256HexSync(JSON.stringify(conversations)),
        ...(offset+50<visible.length?{nextCursor:JSON.stringify({fingerprint,offset:offset+50})}:{})};
}
function cursorOffset(cursor:string|undefined,fingerprint:string):number {
    if(!cursor)return 0;
    let saved;try{saved=JSON.parse(cursor);}catch{throw new KanbanError('CURSOR_STALE');}
    if(!saved||saved.fingerprint!==fingerprint||!Number.isSafeInteger(saved.offset)||saved.offset<0)throw new KanbanError('CURSOR_STALE');
    return saved.offset;
}
function sameResource(left:{system:string;id:string},right:{system:string;id:string}):boolean{return left.system===right.system&&left.id===right.id;}
function projectLabel(row:KanbanDecisionRow,resources:KanbanRecordResource[]=[]):string {
    const references=row.kind==='record'?row.value.externalRefs??[]:row.value.resources??[];
    const primary=row.kind==='conversation'?row.value.primaryResource:undefined;
    const ordered=primary?[...references].sort((a,b)=>Number(sameResource(b,primary))-Number(sameResource(a,primary))):references;
    return [...new Set(ordered.map(ref=>resources.find(item=>sameResource(item.reference,ref))?.label).filter((label):label is string=>!!label))].join('、');
}
