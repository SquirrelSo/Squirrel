import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import { parseAllowedOrigins, registerCors } from "./cors.js";

const app = async (raw: string | undefined): Promise<FastifyInstance> => {
  const fastify = Fastify();
  await registerCors(fastify, raw);
  fastify.get("/v1/ping", () => ({ ok: true }));
  await fastify.ready();
  return fastify;
};

const preflight = (origin: string): InjectOptions => ({
  method: "OPTIONS",
  url: "/v1/ping",
  headers: { origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
});

describe("CORS", () => {
  it("parses exact origins and wildcards, ignoring blanks and trailing slashes", () => {
    const [exact, wild] = parseAllowedOrigins(" https://app.example.com/ , ,https://sq-*-team.vercel.app");
    expect(exact).toBe("https://app.example.com");
    expect(wild).toBeInstanceOf(RegExp);
    const re = wild as RegExp;
    expect(re.test("https://sq-git-main-team.vercel.app")).toBe(true);
    expect(re.test("https://sq-a.evil.com-team.vercel.app")).toBe(false);
    expect(re.test("https://sq--team.vercel.app")).toBe(false);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });

  it("answers the preflight for an allowed origin", async () => {
    const fastify = await app("https://squirrel.vercel.app");
    const res = await fastify.inject(preflight("https://squirrel.vercel.app"));
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://squirrel.vercel.app");
    expect(String(res.headers["access-control-allow-headers"]).toLowerCase()).toContain("authorization");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();

    const get = await fastify.inject({ method: "GET", url: "/v1/ping", headers: { origin: "https://squirrel.vercel.app" } });
    expect(get.headers["access-control-allow-origin"]).toBe("https://squirrel.vercel.app");
    expect(get.headers["access-control-expose-headers"]).toBe("Retry-After");
  });

  it("gives other origins no CORS headers", async () => {
    const fastify = await app("https://squirrel.vercel.app");
    const res = await fastify.inject({ method: "GET", url: "/v1/ping", headers: { origin: "https://evil.example" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("is off when no origins are configured", async () => {
    const fastify = await app("");
    const res = await fastify.inject({ method: "GET", url: "/v1/ping", headers: { origin: "https://squirrel.vercel.app" } });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
