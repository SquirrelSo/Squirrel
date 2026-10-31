export function dayKey(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return 'lb:day:' + y + '-' + m + '-' + d;
}

export function alltimeKey(): string {
  return "lb:alltime";
}

export function processedKey(eventId: string): string {
  return 'lb:processed:' + eventId;
}

export function weeklyTempKey(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return 'lb:weekly:' + y + '-' + m + '-' + d + ':tmp';
}
