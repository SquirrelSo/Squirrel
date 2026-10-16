/**
 * The person's own calendar. Servers store UTC; every "today" / "this week" the app counts follows
 * the phone's clock and time zone, never UTC (a workout at 00:30 IST is 19:00 UTC the day before).
 */

/** The phone's IANA time zone (e.g. "Asia/Kolkata"), sent with sessions and runs so the servers
 *  put them on the same day the person does. Undefined when the platform cannot say. */
export function deviceTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone.length > 0 && zone.length <= 64 ? zone : undefined;
  } catch {
    return undefined;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar day, YYYY-MM-DD. */
export const localDayKey = (at: Date = new Date()) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;

/** Local week (Monday start), keyed by its Monday's day. */
export function localWeekKey(at: Date = new Date()): string {
  const monday = new Date(at.getFullYear(), at.getMonth(), at.getDate() - ((at.getDay() + 6) % 7));
  return localDayKey(monday);
}
