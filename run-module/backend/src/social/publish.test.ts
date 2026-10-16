import { describe, it, expect, vi } from "vitest";
import { publishRun, runActivityPayload, type FinalizedRun } from "./publish.js";

const run: FinalizedRun = {
  runId: "7a1c2b3d-0000-4000-8000-000000000001",
  userId: "3f0c9a4e-1111-4222-8333-444455556666",
  startedAt: new Date("2026-09-28T01:30:00Z"),
  distanceM: 5234.6,
  movingTimeS: 1710.4,
  elapsedTimeS: 1800,
  areaM2: 81234.2,
};
const env = { SOCIAL_API_URL: "https://social.test/", SOCIAL_INTERNAL_TOKEN: "svc-secret" };

describe("publishing runs to Social", () => {
  it("builds the Social activity for a finalized run", () => {
    expect(runActivityPayload(run)).toEqual({
      user_subject: run.userId,
      type: "run",
      source: "run_module",
      source_ref: run.runId,
      started_at: "2026-09-28T01:30:00.000Z",
      name: "5.2 km run",
      distance_m: 5235,
      duration_s: 1710,
      metrics: { elapsed_time_s: 1800, territory_m2: 81234 },
    });
  });

  it("posts with the service token", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 201 }));
    await publishRun(run, env, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://social.test/internal/v1/activities");
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer svc-secret");
    expect(JSON.parse(init.body as string).source_ref).toBe(run.runId);
  });

  it("does nothing without both settings", async () => {
    const fetchImpl = vi.fn();
    await publishRun(run, { SOCIAL_API_URL: "https://social.test" }, fetchImpl as unknown as typeof fetch);
    await publishRun(run, { SOCIAL_INTERNAL_TOKEN: "svc" }, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never throws when Social is down or refuses", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const down = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const refuses = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(publishRun(run, env, down as unknown as typeof fetch)).resolves.toBeUndefined();
    await expect(publishRun(run, env, refuses as unknown as typeof fetch)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
