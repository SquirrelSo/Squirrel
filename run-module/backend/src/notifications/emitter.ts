import crypto from 'crypto';
import { Queue, Worker } from 'bullmq';
import { pool } from '../db/pool.js';
import { redis } from '../redis/client.js';
import { NotificationEvent, NotificationType } from './events.js';

export const notificationDeliveryQueue = new Queue('notification_delivery', { connection: redis });
export const notificationTriggerQueue = new Queue('notification_trigger', { connection: redis });

export const enqueueNotificationSync = async (runId: string | null, eventIds: string[]) => {
  if (eventIds.length === 0) return;
  await notificationTriggerQueue.add(
    'trigger_batch',
    { runId, eventIds },
    { jobId: runId ? 'notif-run-' + runId : 'notif-batch-' + crypto.randomUUID() }
  );
};

export async function emitFromBatch(runId: string | null, eventIds: string[]): Promise<string[]> {
  if (eventIds.length === 0) return [];
  const res = await pool.query("SELECT * FROM capture_events WHERE id = ANY($1)", [eventIds]);
  if (res.rowCount === 0) return [];
  
  const outboxIds: string[] = [];
  
  const createOutbox = async (recipient: string, type: NotificationType, payload: any) => {
    let existing;
    if (payload.run_id) {
      existing = await pool.query(
        "SELECT id FROM notification_outbox WHERE user_id = $1 AND payload->>'run_id' = $2",
        [recipient, payload.run_id]
      );
    } else {
      existing = await pool.query(
        "SELECT id FROM notification_outbox WHERE user_id = $1 AND payload->>'capture_event_id' = $2",
        [recipient, payload.capture_event_id]
      );
    }
    if ((existing.rowCount ?? 0) > 0) return;

    const outboxId = crypto.randomUUID();
    await pool.query(
      "INSERT INTO notification_outbox (id, user_id, event_type, payload) VALUES ($1, $2, $3, $4)",
      [outboxId, recipient, type, payload]
    );
    outboxIds.push(outboxId);
  };

  let claimEvent: any = null;
  let territoriesTaken = 0;
  let actorId: string | null = null;

  for (const row of res.rows) {
    const eventType = row.event_type;
    
    if (eventType === 'expired') {
      if (row.previous_owner_id) {
        await createOutbox(row.previous_owner_id, 'territory_expired', {
          capture_event_id: row.id,
          territory_id: row.territory_id,
          area_delta_m2: Number(row.area_delta_m2)
        });
      }
      continue;
    }

    if (row.actor_id !== row.previous_owner_id) {
      if (eventType === 'claimed') {
        claimEvent = row;
        actorId = row.actor_id;
      } else if (eventType === 'partial_capture' || eventType === 'full_capture') {
        territoriesTaken++;
        actorId = row.actor_id;
        if (row.previous_owner_id) {
          await createOutbox(row.previous_owner_id, 'territory_lost', {
            capture_event_id: row.id,
            territory_id: row.territory_id,
            area_delta_m2: Number(row.area_delta_m2),
            actor_id: row.actor_id
          });
        }
      }
    }
  }

  if (runId && actorId && claimEvent) {
    await createOutbox(actorId, 'territory_captured', {
      run_id: runId,
      territory_id: claimEvent.territory_id,
      area_delta_m2: Number(claimEvent.area_delta_m2),
      territories_taken: territoriesTaken
    });
  } else if (!runId) {
    // Fallback for non-run events (e.g. tests that process single captures without runId)
    for (const row of res.rows) {
      if (row.event_type === 'claimed') {
        await createOutbox(row.actor_id, 'territory_captured', {
          capture_event_id: row.id,
          territory_id: row.territory_id,
          area_delta_m2: Number(row.area_delta_m2),
          actor_id: row.actor_id
        });
      } else if (row.event_type === 'partial_capture' || row.event_type === 'full_capture') {
        if (row.actor_id !== row.previous_owner_id) {
          await createOutbox(row.actor_id, 'territory_captured', {
            capture_event_id: row.id,
            territory_id: row.territory_id,
            area_delta_m2: Number(row.area_delta_m2),
            actor_id: row.actor_id
          });
        }
      }
    }
  }

  await emitPending();
  return outboxIds;
}

export async function emitPending(limit: number = 500): Promise<{ enqueued: number }> {
  const res = await pool.query<OutboxRow>(
    "SELECT * FROM notification_outbox WHERE enqueued_at IS NULL ORDER BY created_at ASC LIMIT $1",
    [limit]
  );
  return enqueueRows(res.rows);
}

/** Enqueue specific pending outbox rows (e.g. a level-up written by the XP award route). */
export async function enqueueOutboxIds(ids: string[]): Promise<{ enqueued: number }> {
  if (ids.length === 0) return { enqueued: 0 };
  const res = await pool.query<OutboxRow>(
    "SELECT * FROM notification_outbox WHERE enqueued_at IS NULL AND id = ANY($1) ORDER BY created_at ASC",
    [ids]
  );
  return enqueueRows(res.rows);
}

type OutboxRow = { id: string; user_id: string; event_type: string; created_at: Date; payload: Record<string, unknown> };

async function enqueueRows(rows: OutboxRow[]): Promise<{ enqueued: number }> {
  let enqueued = 0;
  for (const row of rows) {
    const notifEvent: NotificationEvent = {
      id: row.id,
      user_id: row.user_id,
      type: row.event_type as NotificationType,
      source_module: 'run_module',
      occurred_at: new Date(row.created_at).toISOString(),
      payload: row.payload
    };

    // Push to delivery queue
    // Retried with backoff until the Social service takes it (notifications/deliver.ts).
    await notificationDeliveryQueue.add('deliver', notifEvent, {
      jobId: 'deliver-' + row.id,
      attempts: 8,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
    });
    
    await pool.query(
      "UPDATE notification_outbox SET enqueued_at = now() WHERE id = $1",
      [row.id]
    );
    enqueued++;
  }

  return { enqueued };
}

export function startNotificationWorker() {
  console.log('Starting notification_trigger worker...');
  const worker = new Worker('notification_trigger', async (job) => {
    if (job.name === 'trigger_batch') {
      await emitFromBatch(job.data.runId, job.data.eventIds);
    }
  }, { connection: redis });

  worker.on('failed', (job, err) => {
    console.error('Job ' + (job?.id || 'unknown') + ' failed:', err);
  });

  return worker;
}
