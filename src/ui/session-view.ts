import type {KanbanPresentation} from './ports';
import {escapeHTML, escapeAttr} from './html';
import type {KanbanExecutionSession,KanbanExecutionSessionDetail, KanbanRelatedSession, KanbanSessionExecution} from '../contracts';
import {sessionLink} from './session-links';
import {suggestionField} from './suggestion-field';
export function executionBadge(ui: KanbanPresentation, session?:KanbanExecutionSession,sessionUrl?: (id:string)=>string):string {
    if(!session) return '';
    const resource=session.resourceId??session.sessionId;
    return `<span class="kanban__execution" data-execution-state="${escapeAttr(session.state)}" data-stale="${session.stale}"><span>${sessionUrl?sessionLink(ui,resource,ui.text('executionSession'),sessionUrl(resource)):escapeHTML(ui.text('executionSession'))} · ${escapeHTML(ui.text('sessionState.'+session.state))}${session.stale?' · '+escapeHTML(ui.text('activityStale')):''}</span><small>${escapeHTML(activityTime(ui, session))}</small></span>`;
}
function activityTime(ui: KanbanPresentation, session:KanbanExecutionSession):string {
    if(session.lastActivityAt===undefined) return ui.text('activityUnknown');
    const minutes=Math.max(0,Math.floor((Date.now()-session.lastActivityAt)/60000));
    return ui.text('lastActivity')+' · '+(minutes<1?ui.text('justNow'):minutes<60?ui.text('minutesAgo').replace('{count}',String(minutes)):new Date(session.lastActivityAt).toLocaleString());
}
export function executionSessionView(ui: KanbanPresentation, detail:KanbanExecutionSessionDetail,editable:boolean, sessionUrl?: (id: string) => string):string {
    const session=detail.current,resource=session?.resourceId??session?.sessionId;
    return `<section class="kanban__execution-detail"><h4>${escapeHTML(ui.text('executionSession'))}</h4><p>${escapeHTML(ui.text('executionSessionHelp'))}</p>
        ${detail.continuation ? `<button type="button" data-action="continue-execution" data-dispatch="${escapeAttr(detail.continuation.previousDispatchId)}">${escapeHTML(ui.text('continueExecution'))}</button>` : ''}
        ${session?`${executionBadge(ui, session)}${sessionLink(ui, resource!, session.title ?? session.sessionId, sessionUrl?.(resource!))}<small>${escapeHTML(session.sessionId)}</small>${session.observedAt?`<small>${escapeHTML(ui.text('observedAt'))} · ${escapeHTML(new Date(session.observedAt).toLocaleString())}</small>`:''}${session.code?`<p>${escapeHTML(ui.text('activityReadFailed'))} (${escapeHTML(session.code)})</p>`:''}`:`<p>${escapeHTML(ui.text('noExecutionSession'))}</p>`}
        ${editable?`<details><summary>${escapeHTML(ui.text(session?'changeExecutionSession':'bindExecutionSession'))}</summary><form data-form="execution-session">${suggestionField({name:'executionSession',label:'executionSession',kind:'session',manual:true,required:true})}<button>${escapeHTML(ui.text('bindExecutionSession'))}</button><p data-execution-error role="alert" hidden></p></form></details>`:''}
        </section>`;
}
export function relatedSessionsView(ui: KanbanPresentation, detail: KanbanExecutionSessionDetail, sessionUrl?: (id: string) => string): string {
    const sessions = detail.sessions ?? legacySessions(detail);
    return `${detail.sessionsCode ? `<p role="alert">${escapeHTML(ui.text('sessionRelationsIncomplete'))} (${escapeHTML(detail.sessionsCode)})</p>` : ''}
        ${sessions.length ? `<ul class="kanban__session-list">${sessions.map(session => relatedSession(ui, session, sessionUrl)).join('')}</ul>` : `<p>${escapeHTML(ui.text('noRelatedSessions'))}</p>`}`;
}
function relatedSession(ui: KanbanPresentation, session: KanbanRelatedSession, sessionUrl?: (id: string) => string): string {
    const resource = session.resourceId ?? session.sessionId, title = session.title ?? session.sessionId;
    return `<li class="kanban__related-session" data-related-session="${escapeAttr(session.sessionId)}"><div class="kanban__session-heading" title="${escapeAttr(title)}">${sessionLink(ui, resource, title, sessionUrl?.(resource))}</div>
        <small>${escapeHTML(session.sessionId)}</small>${session.createdAt !== undefined ? `<small>${escapeHTML(ui.text('sessionCreatedAt'))} · ${escapeHTML(date(session.createdAt))}</small>` : ''}<p>${session.current ? `<strong>${escapeHTML(ui.text('currentExecution'))}</strong> · ` : ''}${session.purposes.map(purpose => escapeHTML(ui.text('sessionPurpose.' + purpose))).join(' · ')} · ${escapeHTML(ui.text('sessionState.' + session.state))}${session.stale ? ' · ' + escapeHTML(ui.text('activityStale')) : ''}</p>
        ${session.code ? `<p role="alert">${escapeHTML(ui.text('activityReadFailed'))} (${escapeHTML(session.code)})</p>` : ''}
        ${session.executions.length ? `<details><summary>${escapeHTML(ui.text('sessionExecutions'))} (${session.executions.length})</summary><ol>${session.executions.map(run => executionView(ui, run)).join('')}</ol></details>` : ''}</li>`;
}
function executionView(ui: KanbanPresentation, run: KanbanSessionExecution): string {
    const label = run.previousDispatchId ? ui.text('sessionContinuation') : ui.text('sessionPurpose.' + run.purpose);
    const showState = run.state && run.state !== run.outcome && !(run.state === 'completed' && ['succeeded', 'accepted', 'rejected'].includes(run.outcome ?? ''));
    const fields: Array<[string, string | undefined]> = [[ui.text('sessionExecutionId'), run.id], [ui.text('sessionRoundId'), run.roundId], [ui.text('sessionTurnId'), run.turnId],
        [ui.text('sessionPreviousExecution'), run.previousDispatchId], [ui.text(run.roundId ? 'sessionExecutionStarted' : 'sessionExecutionPrepared'), date(run.createdAt)], [ui.text('sessionExecutionEnded'), date(run.completedAt)],
        ...run.resources?.map(resource => [resource.label, resource.value] as [string, string]) ?? []];
    return `<li class="kanban__session-run"><p>${escapeHTML(label)}${run.attempt ? ' · #' + run.attempt : ''}${run.outcome ? ' · ' + escapeHTML(ui.text('sessionRunOutcome.' + run.outcome)) : ''}${showState ? ' · ' + escapeHTML(ui.text('sessionState.' + run.state)) : ''}</p>
        <dl>${fields.filter((field): field is [string, string] => field[1] !== undefined).map(([key, value]) => `<dt>${escapeHTML(key)}</dt><dd>${escapeHTML(value)}</dd>`).join('')}</dl>${run.code ? `<p role="alert">${escapeHTML(run.code)}</p>` : ''}</li>`;
}
function date(value?: number): string | undefined {return value === undefined ? undefined : new Date(value).toLocaleString();}
function legacySessions(detail: KanbanExecutionSessionDetail): KanbanRelatedSession[] {
    return [...new Map(detail.history.map(row => [row.sessionId, row])).values()].map(row => ({
        ...(detail.current?.sessionId === row.sessionId ? detail.current : {sessionId: row.sessionId, state: 'unknown' as const, stale: true, recent: false}),
        current: detail.current?.sessionId === row.sessionId, purposes: ['execution'], executions: [],
    }));
}
export function executionFilter(ui: KanbanPresentation, value='all'):string {
    return `<select name="execution" aria-label="${escapeAttr(ui.text('executionFilter'))}">${['all','running','recent','active'].map(filter=>`<option value="${filter}" ${filter===value?'selected':''}>${escapeHTML(ui.text('executionFilter.'+filter))}</option>`).join('')}</select>`;
}
