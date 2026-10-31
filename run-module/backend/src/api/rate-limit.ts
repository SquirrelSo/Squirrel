import fp from 'fastify-plugin';
import fastifyRateLimit, { RateLimitOptions } from '@fastify/rate-limit';
import { redis } from '../redis/client.js';

// BullMQ requires the shared Redis connection to retry indefinitely. API rate
// limiting uses a separate, bounded connection so Redis outages fail open.
export const rateLimitRedis = redis.duplicate({
  maxRetriesPerRequest: 2,
  connectTimeout: 1000,
});

rateLimitRedis.on('error', (err: Error) => {
  console.warn('[rate-limit] Redis error; requests will fail open:', err.message);
});

export const rateLimitPlugin = fp(async (fastify) => {
  await fastify.register(fastifyRateLimit, {
    redis: rateLimitRedis,
    global: false,
    skipOnError: true,
    addHeadersOnExceeding: {
      'x-ratelimit-limit': false,
      'x-ratelimit-remaining': false,
      'x-ratelimit-reset': false,
    },
    addHeaders: {
      'retry-after': true,
      'x-ratelimit-limit': false,
      'x-ratelimit-remaining': false,
      'x-ratelimit-reset': false,
    },
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Rate limit exceeded',
    }),
    keyGenerator: (req) => {
      if (req.userId) return req.userId;
      req.log.warn('Rate limit fallback to IP due to missing userId');
      return req.ip;
    },
    onExceeded: (req) => {
      req.log.info({ userId: req.userId, route: req.routeOptions.url }, 'Rate limit exceeded');
    },
  });
});

export function getRateLimitOptions(max: number, timeWindow: string, suffix: string): RateLimitOptions {
  return {
    max,
    timeWindow,
    keyGenerator: (req) => {
      if (req.userId) return `${req.userId}-${suffix}`;
      req.log.warn('Rate limit fallback to IP due to missing userId');
      return `${req.ip}-${suffix}`;
    },
  };
}
