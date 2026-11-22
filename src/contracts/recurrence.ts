/** A schedule is frozen into each execution; controls affect future executions only. */
export interface KanbanRecurrence {
    state:'active'|'paused'|'stopped';
    firstAt:number;
    timeZone:string;
    cadence:{kind:'interval';milliseconds:number}|{kind:'calendar';hour:number;minute:number;weekdays:number[]};
    trigger:'after-settlement'|'fixed';
    maxConcurrency:number;
}
export interface KanbanRecurrenceReservation {
    id:string;configRevision:number;scheduledAt:number;record:import('./context').KanbanProjectRecord;
}
export interface KanbanRecurrenceFence {
    last?:{configRevision:number;scheduledAt:number};
    pending:KanbanRecurrenceReservation[];
}
