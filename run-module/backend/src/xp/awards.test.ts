import { describe, expect, it } from "vitest";
import {
  AWARD_RULES, challengeEntries, checkAward, externalEntries, CHALLENGE_DAILY_CAP, EXTERNAL_DAILY_CAP,
  TERRITORY_DAILY_CAP, type ExternalAwardRow,
} from "./awards.js";
import { levelForXp, summarize, xpByCategory } from "./rules.js";
import { outboxIdFor } from "./level-up.js";

const IST = "Asia/Kolkata";
const SUBJECT = "11111111-1111-4111-8111-111111111111";
const base = { subject: SUBJECT, idempotency_key: "k-1" };

describe("checkAward: the award catalogue (ADR-033)", () => {
  it("accepts every source/reason at its exact or maximum amount", () => {
    const ok: [string, string, number, string?][] = [
      ["campus", "territory_claim", 100], ["campus", "territory_steal", 1], ["campus", "territory_defend", 50],
      ["campus", "meetup_checkin", 25, `meetup:m-1:${SUBJECT}`],
      ["exercise", "shared_workout_finished", 20], ["exercise", "buddy_connected", 20, `buddy:pair-1:${SUBJECT}`],
      ["social", "ambassador_referral", 50], ["social", "ambassador_task", 200], ["social", "special_event", 100],
    ];
    for (const [source, reason, amount, key] of ok) {
      expect(checkAward({ ...base, source, reason, amount, idempotency_key: key ?? "k-1" })).toBeNull();
    }
    expect(AWARD_RULES.size).toBe(ok.length);
  });

  it("refuses amounts other than the exact one, above the maximum, or below 1", () => {
    const bad: [string, string, number, string?][] = [
      ["campus", "territory_claim", 101], ["campus", "territory_claim", 0],
      ["campus", "meetup_checkin", 26, `meetup:m-1:${SUBJECT}`], ["campus", "meetup_checkin", 24, `meetup:m-1:${SUBJECT}`],
      ["exercise", "shared_workout_finished", 21], ["exercise", "buddy_connected", 40, `buddy:p:${SUBJECT}`],
      ["social", "ambassador_referral", 500], ["social", "ambassador_task", 201], ["social", "ambassador_task", -5],
      ["social", "special_event", 101], ["social", "special_event", 1.5],
    ];
    for (const [source, reason, amount, key] of bad) {
      expect(checkAward({ ...base, source, reason, amount, idempotency_key: key ?? "k-1" })).toMatch(/amount/);
    }
  });

  it("refuses unknown sources and reasons, and a reason from another source", () => {
    expect(checkAward({ ...base, source: "run", reason: "territory_claim", amount: 10 })).toMatch(/unknown/);
    expect(checkAward({ ...base, source: "campus", reason: "free_xp", amount: 10 })).toMatch(/unknown/);
    expect(checkAward({ ...base, source: "social", reason: "territory_claim", amount: 10 })).toMatch(/unknown/);
  });

  it("holds the once-per-meetup and once-per-pair keys to the contract's format, for this subject", () => {
    const meetup = { ...base, source: "campus", reason: "meetup_checkin", amount: 25 };
    expect(checkAward({ ...meetup, idempotency_key: "anything" })).toMatch(/meetup:\{id\}:\{subject\}/);
    expect(checkAward({ ...meetup, idempotency_key: "meetup:m-1:22222222-2222-4222-8222-222222222222" })).toMatch(/meetup/);
    expect(checkAward({ ...meetup, idempotency_key: `meetup:m-1:${SUBJECT.toUpperCase()}` })).toBeNull();
    const buddy = { ...base, source: "exercise", reason: "buddy_connected", amount: 20 };
    expect(checkAward({ ...buddy, idempotency_key: `buddy:${SUBJECT}` })).toMatch(/buddy/);
    expect(checkAward({ ...buddy, idempotency_key: `meetup:m:${SUBJECT}` })).toMatch(/buddy/);
    // Exercise's pair key is {low}:{high}, so the id part may contain ':'
    expect(checkAward({ ...buddy, idempotency_key: `buddy:aaaa:bbbb:${SUBJECT}` })).toBeNull();
  });

  it("bounds the key, source_id and metadata", () => {
    const award = { ...base, source: "social", reason: "special_event", amount: 10 };
    expect(checkAward({ ...award, idempotency_key: "" })).toMatch(/idempotency_key/);
    expect(checkAward({ ...award, idempotency_key: "x".repeat(201) })).toMatch(/idempotency_key/);
    expect(checkAward({ ...award, source_id: "x".repeat(200) })).toBeNull();
    expect(checkAward({ ...award, source_id: "x".repeat(201) })).toMatch(/source_id/);
    expect(checkAward({ ...award, metadata: { note: "x".repeat(2000) } })).toBeNull();
    expect(checkAward({ ...award, metadata: { note: "x".repeat(2100) } })).toMatch(/metadata/);
  });
});

let n = 0;
const award = (over: Partial<ExternalAwardRow> & { reason: string; amount: number }): ExternalAwardRow => {
  n += 1;
  return {
    source: over.reason.startsWith("territory") || over.reason === "meetup_checkin" ? "campus"
      : over.reason === "shared_workout_finished" || over.reason === "buddy_connected" ? "exercise" : "social",
    idempotency_key: `k-${String(n).padStart(4, "0")}`,
    source_id: null,
    created_at: new Date(Date.UTC(2026, 8, 26, 4, 0, n)),
    reversed_at: null,
    ...over,
  };
};

describe("external awards on read (ADR-033)", () => {
  it("caps everything but territory at 300 a day, cutting the latest, kept for audit as a cap line", () => {
    const rows = [award({ reason: "ambassador_task", amount: 200 }), award({ reason: "special_event", amount: 100 }),
      award({ reason: "meetup_checkin", amount: 25 })];
    const summary = summarize(externalEntries(rows, IST));
    expect(summary.xp).toBe(EXTERNAL_DAILY_CAP);
    expect(summary.breakdown).toContainEqual({ reason: "campus_awards_daily_cap", xp: -25 });
    // the next day starts fresh
    const next = award({ reason: "special_event", amount: 100, created_at: new Date("2026-09-27T04:00:00Z") });
    expect(summarize(externalEntries([...rows, next], IST)).xp).toBe(EXTERNAL_DAILY_CAP + 100);
  });

  it("counts only the first 3 shared workouts a day; the 4th uses none of the 300 cap", () => {
    const rows = [1, 2, 3, 4].map(() => award({ reason: "shared_workout_finished", amount: 20 }));
    const entries = externalEntries([...rows, award({ reason: "ambassador_task", amount: 200 }), award({ reason: "special_event", amount: 40 })], IST);
    const summary = summarize(entries);
    expect(summary.xp).toBe(60 + 200 + 40);
    expect(summary.breakdown).toContainEqual({ reason: "shared_workout_daily_limit", xp: -20 });
    expect(xpByCategory(entries)).toMatchObject({ exercise: 60, social: 240 });
  });

  it("keeps the territory cap (150) separate from the 300 cap", () => {
    const rows = [...[1, 2, 3, 4].map(() => award({ reason: "territory_claim", amount: 50 })),
      award({ reason: "ambassador_task", amount: 200 }), award({ reason: "special_event", amount: 100 })];
    const summary = summarize(externalEntries(rows, IST));
    expect(summary.xp).toBe(TERRITORY_DAILY_CAP + EXTERNAL_DAILY_CAP);
    expect(summary.breakdown).toContainEqual({ reason: "territory_daily_cap", xp: -50 });
  });

  it("a reversed award counts 0 and uses no cap, but stays listed", () => {
    const reversed = award({ reason: "ambassador_task", amount: 200, reversed_at: new Date() });
    const rows = [reversed, award({ reason: "ambassador_task", amount: 200 }), award({ reason: "special_event", amount: 100 })];
    const entries = externalEntries(rows, IST);
    expect(summarize(entries).xp).toBe(300);
    expect(entries.find((e) => e.reversed)).toMatchObject({ xp: 200, reason: "ambassador_task" });
    // freeing a shared-workout slot lets the 4th count, so a reversal never adds XP overall
    const sw = [1, 2, 3, 4].map(() => award({ reason: "shared_workout_finished", amount: 20 }));
    const before = summarize(externalEntries(sw, IST)).xp;
    const after = summarize(externalEntries([{ ...sw[0]!, reversed_at: new Date() }, ...sw.slice(1)], IST)).xp;
    expect([before, after]).toEqual([60, 60]);
  });

  it("caps challenge wins at 200 XP a day", () => {
    const wins = [
      { challenge_id: "a", xp_awarded: 150, resolved_at: new Date("2026-09-26T04:00:00Z") },
      { challenge_id: "b", xp_awarded: 150, resolved_at: new Date("2026-09-26T05:00:00Z") },
      { challenge_id: "c", xp_awarded: 150, resolved_at: new Date("2026-09-27T05:00:00Z") },
    ];
    const summary = summarize(challengeEntries(wins, IST));
    expect(summary.xp).toBe(CHALLENGE_DAILY_CAP + 150);
    expect(summary.breakdown).toEqual([
      { reason: "challenge completed", xp: 450 },
      { reason: "challenge_daily_cap", xp: -100 },
    ]);
  });
});

describe("levels and level-up dedupe", () => {
  it("a level every 2000 XP", () => {
    expect(levelForXp(0).level).toBe(1);
    expect(levelForXp(1999).level).toBe(1);
    expect(levelForXp(2000).level).toBe(2);
  });

  it("the outbox id is a UUID fixed by the dedupe key", () => {
    const id = outboxIdFor(`level:${SUBJECT}:2`);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(outboxIdFor(`level:${SUBJECT}:2`)).toBe(id);
    expect(outboxIdFor(`level:${SUBJECT}:3`)).not.toBe(id);
  });
});
