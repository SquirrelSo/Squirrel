import { socialSettings } from '../identity/index.js';

const CACHE_TTL_MS = 60_000;
const BACKOFF_MS = 30_000;
let lastKnown: { crewsTotal: number; at: number } | null = null;
let downUntil = 0;

/** Read Social's count, using the last known value on failure and zero only before any success. */
export async function socialCrewCount(): Promise<number> {
  const now = Date.now();
  if (lastKnown && now - lastKnown.at < CACHE_TTL_MS) return lastKnown.crewsTotal;
  const settings = socialSettings();
  if (!settings || now < downUntil) return lastKnown?.crewsTotal ?? 0;

  try {
    const response = await fetch(`${settings.url}/internal/v1/crews/count`, {
      headers: { authorization: `Bearer ${settings.token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Social crew count HTTP ${response.status}`);
    }
    const result = await response.json() as { crews_total?: unknown; as_of?: unknown };
    if (!Number.isSafeInteger(result.crews_total) || (result.crews_total as number) < 0 || typeof result.as_of !== 'string') {
      throw new Error('Social crew count response is invalid');
    }
    lastKnown = { crewsTotal: result.crews_total as number, at: Date.now() };
    downUntil = 0;
    return lastKnown.crewsTotal;
  } catch {
    downUntil = Date.now() + BACKOFF_MS;
    return lastKnown?.crewsTotal ?? 0;
  }
}

/** Reset process-local cache state for isolated integration tests. */
export function resetSocialCrewCountCache() {
  lastKnown = null;
  downUntil = 0;
}
