import { describe, expect, it } from "vitest";
import { deliverNotification, RetryableDeliveryError, socialNotificationPayload } from "./deliver.js";
import type { NotificationEvent } from "./events.js";

const ENV = { SOCIAL_API_URL: "https://social.test/", SOCIAL_INTERNAL_TOKEN: "svc" } as NodeJS.ProcessEnv;

const lost: NotificationEvent = {
  id: "11111111-1111-4111-8111-111111111111",
  user_id: "22222222-2222-4222-8222-222222222222",
  type: "territory_lost",
  source_module: "run_module",
  occurred_at: "2026-09-29T06:00:00.000Z",
  payload: {
    capture_event_id: "ce-1",
    territory_id: "t-1",
    area_delta_m2: 1234.5,
    actor_id: "33333333-3333-4333-8333-333333333333",
    ignored: { nested: true },
  },
};

function fakeFetch(status: number, calls: { url: string; init: RequestInit }[] = []): typeof fetch {
  return ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response("{}", { status }));
  }) as unknown as typeof fetch;
}

describe("socialNotificationPayload", () => {
  it("names the victim and the thief by their account ids and dedupes on the outbox id", () => {
    expect(socialNotificationPayload(lost)).toEqual({
      user_subject: lost.user_id,
      kind: "territory_lost",
      actor_subject: "33333333-3333-4333-8333-333333333333",
      data: { capture_event_id: "ce-1", territory_id: "t-1", area_delta_m2: 1234.5 },
      dedupe_key: `run_module:${lost.id}`,
    });
  });

  it("leaves out the actor when it is the recipient (their own capture)", () => {
    const own = { ...lost, type: "territory_captured" as const, payload: { ...lost.payload, actor_id: lost.user_id } };
    expect(socialNotificationPayload(own)).not.toHaveProperty("actor_subject");
  });
});

describe("xp.level_up (ADR-033)", () => {
  it("carries a title, the level and XP, the progress route and the level dedupe key", () => {
    const user = "22222222-2222-4222-8222-222222222222";
    const event: NotificationEvent = {
      id: "44444444-4444-4444-8444-444444444444",
      user_id: user,
      type: "xp.level_up",
      source_module: "run_module",
      occurred_at: "2026-10-07T06:00:00.000Z",
      payload: { level: 3, xp: 4010, dedupe_key: `level:${user}:3` },
    };
    expect(socialNotificationPayload(event)).toEqual({
      user_subject: user,
      kind: "xp.level_up",
      title: "You reached level 3!",
      body: "4010 XP so far. Keep it up.",
      data: { level: 3, xp: 4010, route: "/progress" },
      dedupe_key: `level:${user}:3`,
    });
  });
});

describe("deliverNotification", () => {
  it("posts to the Social service with the service token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    await expect(deliverNotification(lost, ENV, fakeFetch(200, calls))).resolves.toBe("delivered");
    expect(calls[0]!.url).toBe("https://social.test/internal/v1/notifications");
    expect((calls[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer svc");
  });

  it("does nothing without the Social settings", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    await expect(deliverNotification(lost, {} as NodeJS.ProcessEnv, fakeFetch(200, calls))).resolves.toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  it("throws on 5xx and network errors so the job is retried", async () => {
    await expect(deliverNotification(lost, ENV, fakeFetch(503))).rejects.toBeInstanceOf(RetryableDeliveryError);
    const down = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    await expect(deliverNotification(lost, ENV, down)).rejects.toBeInstanceOf(RetryableDeliveryError);
  });

  it("drops a 4xx: a retry cannot fix it", async () => {
    await expect(deliverNotification(lost, ENV, fakeFetch(422))).resolves.toBe("dropped");
  });
});
