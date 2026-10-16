/** Alarm clock maths — pure, unit-tested (alarmTime.test.mjs). Times are the device's local time. */

export type ClockTime = { hour: number; minute: number }; // hour 0–23

/** The next moment this time occurs, strictly after `now`. */
export function nextFireAt({ hour, minute }: ClockTime, now: Date = new Date()): Date {
  const d = new Date(now.getTime());
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

/** "07:30 AM" */
export function formatClock({ hour, minute }: ClockTime): { time: string; ampm: 'AM' | 'PM'; full: string } {
  const ampm = hour < 12 ? 'AM' : 'PM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const time = `${String(h12).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return { time, ampm, full: `${time} ${ampm}` };
}

/** "in 7 h 25 min" / "in 4 min" / "in less than a minute" */
export function untilText(at: Date, now: Date = new Date()): string {
  const mins = Math.round((at.getTime() - now.getTime()) / 60000);
  if (mins < 1) return 'in less than a minute';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `in ${h ? `${h} h ` : ''}${m ? `${m} min` : ''}`.trim();
}

/** 12-hour picker value → 24-hour clock. */
export function to24(h12: number, minute: number, ampm: 'AM' | 'PM'): ClockTime {
  const base = h12 % 12;
  return { hour: ampm === 'PM' ? base + 12 : base, minute };
}

export function from24({ hour, minute }: ClockTime): { h12: number; minute: number; ampm: 'AM' | 'PM' } {
  return { h12: hour % 12 === 0 ? 12 : hour % 12, minute, ampm: hour < 12 ? 'AM' : 'PM' };
}
