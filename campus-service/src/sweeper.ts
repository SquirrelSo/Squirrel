/**
 * Periodic clean-up, every SWEEP_INTERVAL_MS (default 1 min): deletes expired presence rows (exact fixes are
 * not kept past their TTL) and expired / no-longer-consenting bubble members (their neighbours get
 * bubble.user_left). Runs in the worker process, and in the API process when WORKER_INLINE.
 */
import { config } from './config.js';
import { sweepPresence } from './presence/service.js';
import { sweepBubble } from './bubble/service.js';

type Log = { warn: (o: unknown, m?: string) => void; info?: (o: unknown, m?: string) => void };

export async function runSweeps(): Promise<{ presence: number; bubble: number }> {
  const presence = await sweepPresence();
  const bubble = await sweepBubble();
  return { presence, bubble };
}

/** Start the interval; stops when `signal` aborts. Overlapping runs are skipped. */
export function startSweeper(log: Log, signal?: AbortSignal, intervalMs = config.sweep.intervalMs): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runSweeps(); } catch (err) { log.warn({ err }, 'sweep failed'); } finally { running = false; }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  const stop = () => clearInterval(timer);
  signal?.addEventListener('abort', stop, { once: true });
  return stop;
}
