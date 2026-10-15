/**
 * src/notifications/deliver.ts
 *
 * Delivers the notification_delivery queue (territory captured, lost, expired: emitter.ts; XP level
 * ups: xp/level-up.ts) to the
 * Social service, which keeps the in-app list and sends the pushes:
 * POST {SOCIAL_API_URL}/internal/v1/notifications with the service token SOCIAL_INTERNAL_TOKEN.
 *
 * The outbox row's id is the dedupe key, so a retried job lands once. A network error or a 5xx
 * throws, and BullMQ retries with backoff (a sleeping free-plan Social service wakes up in the
 * meantime); a 4xx is logged and dropped, since retrying cannot fix it. Without both settings,
 * delivery is skipped.
 */

import { Worker } from "bullmq";
import { redis } from "../redis/client.js";
import type { NotificationEvent } from "./events.js";

export const DELIVERY_TIMEOUT_MS = 90_000;

/** The Social service's InternalNotificationIn for one outbox event. */
export function socialNotificationPayload(event: NotificationEvent): Record<string, unknown> {
  const p = event.payload ?? {};
  if (event.type === "xp.level_up") {
    // Not a territory kind: Social takes the text from the caller (CONTRACT §2), and dedupes per
    // user on level:{subject}:{level}, so a level is announced once even if XP dips and returns.
    const level = typeof p["level"] === "number" ? p["level"] : 0;
    const xp = typeof p["xp"] === "number" ? p["xp"] : 0;
    return {
      user_subject: event.user_id,
      kind: event.type,
      title: `You reached level ${level}!`,
      body: `${xp} XP so far. Keep it up.`,
      data: { level, xp, route: "/progress" },
      dedupe_key: typeof p["dedupe_key"] === "string" ? p["dedupe_key"] : `level:${event.user_id}:${level}`,
    };
  }
  const data: Record<string, unknown> = {};
  for (const key of ["capture_event_id", "run_id", "territory_id", "area_delta_m2", "territories_taken"]) {
    const value = p[key];
    if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) data[key] = value;
  }
  const actor = typeof p["actor_id"] === "string" && p["actor_id"] !== event.user_id ? p["actor_id"] : null;
  return {
    user_subject: event.user_id,
    kind: event.type,
    ...(actor ? { actor_subject: actor } : {}),
    data,
    dedupe_key: `run_module:${event.id}`,
  };
}

export class RetryableDeliveryError extends Error {}

/** Deliver one event. Resolves when delivered, skipped or dropped; rejects only when a retry may help. */
export async function deliverNotification(
  event: NotificationEvent,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<"delivered" | "skipped" | "dropped"> {
  const url = (env["SOCIAL_API_URL"] ?? "").trim().replace(/\/+$/, "");
  const token = (env["SOCIAL_INTERNAL_TOKEN"] ?? "").trim();
  if (!url || !token) return "skipped";
  let res: Response;
  try {
    res = await fetchImpl(`${url}/internal/v1/notifications`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(socialNotificationPayload(event)),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
  } catch (err) {
    throw new RetryableDeliveryError(`Social unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.ok) return "delivered";
  const detail = (await res.text()).slice(0, 200);
  if (res.status >= 500 || res.status === 429) throw new RetryableDeliveryError(`Social answered ${res.status}: ${detail}`);
  console.warn(`Social refused notification ${event.id}: HTTP ${res.status} ${detail}`);
  return "dropped";
}

export function startNotificationDeliveryWorker(): Worker {
  console.log("Starting notification_delivery worker...");
  const worker = new Worker<NotificationEvent>(
    "notification_delivery",
    async (job) => {
      await deliverNotification(job.data);
    },
    { connection: redis },
  );
  worker.on("failed", (job, err) => {
    console.warn(`Notification delivery ${job?.id ?? "unknown"} failed (attempt ${job?.attemptsMade ?? "?"}): ${err.message}`);
  });
  return worker;
}
