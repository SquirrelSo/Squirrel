# ADR-019: Notification Event Contract & Shared Pipeline

## Context
Per the Integration Report (sections 3.1 and 4.1), the Run Module shares a notification delivery pipeline with the Exercise Module. This means:
1. There is one quiet-hours setting, one push token registry, and one delivery service shared across the system.
2. The Run Module does NOT own or build delivery infrastructure (no APNs/FCM clients, no token tables). 
3. Both modules emit push events to a shared queue in a common shape, deciding only *when* to fire.

## Decision

### 1. Scope Boundary
The Run Module is strictly responsible for triggering territory events and persisting an outbox record. It will **not** build a delivery service, device token registry, or quiet-hours logic.

### 2. Event Shape (Provisional)
We define a minimal, shared event shape. Because this must be shared across the entire system, **it must be jointly ratified with the Exercise Module engineer before merge stage 4**. It is provisional until then:

```typescript
interface NotificationEvent {
  id: string;
  user_id: string;          // the RECIPIENT
  type: NotificationType;
  source_module: 'run_module';
  occurred_at: string;      // ISO 8601
  payload: Record<string, unknown>;
}

type NotificationType =
  | 'territory_captured'
  | 'territory_lost'
  | 'territory_expired';
```
*(No exercise-side types or delivery-specific fields are included here; delivery fields belong strictly to the pipeline.)*

### 3. Outbox Pattern
We use a `notification_outbox` table. Idempotency is guaranteed via an existence check (SELECT id WHERE user_id = $1 AND payload->>'capture_event_id' = $2) before inserting. When an event is triggered, a row is created with `enqueued_at = NULL`. The event is pushed to the BullMQ delivery queue. Once successfully queued, `enqueued_at` is set. This makes emission provable and recoverable — a failed queue push leaves the row pending, which a `emitPending` sweeper can later retry.

### 4. Recipient-Not-Actor Attribution
For territory captures, the recipient is the user the event happened *to*. A carve notifies the victim (the previous owner), not the attacker. The attacker receives a 'territory_captured' event. 

### 5. Self-Capture Suppression
If a user recaptures their own territory, no notification is emitted. `actor_id === previous_owner_id` produces zero rows.

### 6. Latency
No target latency is defined in the specification. Therefore, we measure and report latency in our tests rather than asserting a strict threshold.
