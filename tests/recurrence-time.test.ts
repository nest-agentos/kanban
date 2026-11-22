import {describe,expect,it} from 'vitest';
import type {KanbanRecurrence} from '../src/contracts';
import {nextRecurrence} from '../src/runtime/recurrence-time';
const firstAt=Date.parse('2026-01-01T00:00:00Z');
const base:KanbanRecurrence={state:'active',firstAt,timeZone:'UTC',trigger:'fixed',maxConcurrency:1,cadence:{kind:'interval',milliseconds:60_000}};
describe('recurrence times',()=>{
 it('uses the first time and skips missed interval slots',()=>{
  expect(nextRecurrence(base,firstAt-1)).toBe(firstAt);
  expect(nextRecurrence(base,firstAt+180_001)).toBe(firstAt+240_000);
 });
 it('uses the calendar time in the chosen time zone and skips a nonexistent DST time',()=>{
  const config:KanbanRecurrence={...base,firstAt:0,timeZone:'America/New_York',cadence:{kind:'calendar',hour:2,minute:30,weekdays:[0,1,2,3,4,5,6]}};
  expect(new Date(nextRecurrence(config,Date.parse('2026-03-07T08:00:00Z'))).toISOString()).toBe('2026-03-09T06:30:00.000Z');
 });
 it('fires an ambiguous local time only once',()=>{
  const config:KanbanRecurrence={...base,firstAt:0,timeZone:'America/New_York',cadence:{kind:'calendar',hour:1,minute:30,weekdays:[0,1,2,3,4,5,6]}};
  expect(new Date(nextRecurrence(config,Date.parse('2026-11-01T04:00:00Z'))).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  expect(new Date(nextRecurrence(config,Date.parse('2026-11-01T05:30:00Z'))).toISOString()).toBe('2026-11-02T06:30:00.000Z');
 });
});
