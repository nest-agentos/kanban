import type {KanbanRecurrence} from './contracts';
import {requireValue} from './rules';

export function validateRecurrence(value:KanbanRecurrence):void {
    requireValue(value&&['active','paused','stopped'].includes(value.state),'RECURRENCE_STATE_INVALID');
    requireValue(Number.isSafeInteger(value.firstAt)&&value.firstAt>=0,'RECURRENCE_FIRST_TIME_INVALID');
    requireValue(typeof value.timeZone==='string'&&value.timeZone.length<=100,'RECURRENCE_TIME_ZONE_INVALID');
    try {new Intl.DateTimeFormat('en',{timeZone:value.timeZone});} catch {requireValue(false,'RECURRENCE_TIME_ZONE_INVALID');}
    requireValue(['fixed','after-settlement'].includes(value.trigger),'RECURRENCE_TRIGGER_INVALID');
    requireValue(Number.isInteger(value.maxConcurrency)&&value.maxConcurrency>=1&&value.maxConcurrency<=20,'RECURRENCE_CONCURRENCY_INVALID');
    requireValue(value.trigger==='fixed'||value.maxConcurrency===1,'RECURRENCE_CONCURRENCY_INVALID');
    const cadence=value.cadence;
    requireValue(cadence&&['interval','calendar'].includes(cadence.kind),'RECURRENCE_CADENCE_INVALID');
    if(cadence.kind==='interval')requireValue(Number.isSafeInteger(cadence.milliseconds)&&cadence.milliseconds>=60_000,'RECURRENCE_INTERVAL_INVALID');
    else {
        requireValue(Number.isInteger(cadence.hour)&&cadence.hour>=0&&cadence.hour<24&&Number.isInteger(cadence.minute)&&cadence.minute>=0&&cadence.minute<60,'RECURRENCE_TIME_INVALID');
        requireValue(Array.isArray(cadence.weekdays)&&cadence.weekdays.length>0&&cadence.weekdays.length<=7&&new Set(cadence.weekdays).size===cadence.weekdays.length&&cadence.weekdays.every(day=>Number.isInteger(day)&&day>=0&&day<=6),'RECURRENCE_WEEKDAYS_INVALID');
    }
}
