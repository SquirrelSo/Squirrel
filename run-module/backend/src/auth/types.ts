/**
 * src/auth/types.ts
 *
 * Fastify request type augmentation for authenticated routes (RM-0c).
 *
 * Importing this module extends Fastify's FastifyRequest interface so that
 * routes protected by requireAuth can access request.userId without a cast.
 *
 * Only import this file in modules that handle authenticated requests.
 * The extension is module-scoped — it does not affect routes that never
 * import this file.
 */

import type { FastifyRequest } from "fastify";

/**
 * Properties added to FastifyRequest by the requireAuth hook.
 * These are ONLY present after requireAuth has run successfully.
 * Accessing them on an unauthenticated request is a programming error.
 */
export interface AuthenticatedRequest {
  /**
   * The verified subject (sub) claim from the JWT, validated as a UUID.
   * Guaranteed to be a well-formed UUID v4/v5 string.
   * Suitable for writing directly to uuid columns in the database.
   *
   * TRUST BOUNDARY: this value comes from the verified JWT signature only.
   * It must never be read from a body, query parameter, or any header
   * other than the Authorization Bearer token.
   */
  userId: string;
}

// Augment Fastify's type so request.userId is available without casting
// on routes that use requireAuth.
declare module "fastify" {
  interface FastifyRequest extends AuthenticatedRequest {}
}

// Re-export so importers can access the type without a separate import path
export type { FastifyRequest };
