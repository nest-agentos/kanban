import type {KanbanRecurrence} from '../contracts';

type Calendar=Extract<KanbanRecurrence['cadence'],{kind:'calendar'}>;
type Local={year:number;month:number;day:number;hour:number;minute:number};
const day=86_400_000;

/** Return the first scheduled instant strictly after the supplied instant. */
export function nextRecurrence(config:KanbanRecurrence,after:number):number {
    if(after<config.firstAt)return config.firstAt;
    if(config.cadence.kind==='interval')return config.firstAt+(Math.floor((after-config.firstAt)/config.cadence.milliseconds)+1)*config.cadence.milliseconds;
    return nextCalendar(config.cadence,config.timeZone,after);
}
export function currentRecurrenceSlot(config:KanbanRecurrence,now:number):number|undefined {
    if(now<config.firstAt)return;
    if(config.cadence.kind==='interval')return config.firstAt+Math.floor((now-config.firstAt)/config.cadence.milliseconds)*config.cadence.milliseconds;
    const local=parts(config.timeZone,now),weekday=new Date(Date.UTC(local.year,local.month-1,local.day)).getUTCDay();
    const time=config.cadence.weekdays.includes(weekday)?calendarInstant(config.timeZone,{...local,hour:config.cadence.hour,minute:config.cadence.minute}):undefined;
    if(time!==undefined&&time>=config.firstAt&&time<=now)return time;
}
function parts(zone:string,instant:number):Local {
    const fields=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(instant);
    const value=(name:string)=>Number(fields.find(field=>field.type===name)?.value);
    return {year:value('year'),month:value('month'),day:value('day'),hour:value('hour'),minute:value('minute')};
}
function stamp(value:Local):number {return Date.UTC(value.year,value.month-1,value.day,value.hour,value.minute);}
function calendarInstant(zone:string,value:Local):number|undefined {
    const target=stamp(value),offsets=new Set<number>();
    for(const delta of [-2*day,-day,0,day,2*day]){
        const probe=target+delta;offsets.add(stamp(parts(zone,probe))-probe);
    }
    const matches=[...offsets].map(offset=>target-offset).filter(candidate=>stamp(parts(zone,candidate))===target);
    return matches.length?Math.min(...matches):undefined;
}
function nextCalendar(cadence:Calendar,zone:string,after:number):number {
    const local=parts(zone,after),date=Date.UTC(local.year,local.month-1,local.day);
    for(let offset=0;offset<=14;offset++){
        const current=new Date(date+offset*day);if(!cadence.weekdays.includes(current.getUTCDay()))continue;
        const instant=calendarInstant(zone,{year:current.getUTCFullYear(),month:current.getUTCMonth()+1,day:current.getUTCDate(),hour:cadence.hour,minute:cadence.minute});
        if(instant!==undefined&&instant>after)return instant;
    }
    throw Object.assign(new Error('Calendar occurrence unavailable'),{code:'RECURRENCE_CALENDAR_UNAVAILABLE'});
}
