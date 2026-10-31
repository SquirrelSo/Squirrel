/**
 * Consistent API errors. Wire format (matches the mobile client's expectations):
 *   { code: 'not_qualified', detail: 'Human-readable message', ...extra }
 * `code` is a stable machine string for the frontend; `detail` is shown to users.
 */
export class ApiError extends Error {
  constructor(public status: number, public code: string, detail: string, public extra: Record<string, unknown> = {}) {
    super(detail);
  }
  toJSON() {
    return { code: this.code, detail: this.message, ...this.extra };
  }
}

export const errors = {
  unauthorized: (detail = 'Sign in to continue') => new ApiError(401, 'unauthorized', detail),
  forbidden: (detail = 'You are not allowed to do that') => new ApiError(403, 'forbidden', detail),
  notFound: (what = 'Resource') => new ApiError(404, 'not_found', `${what} not found`),
  invalid: (detail: string, extra: Record<string, unknown> = {}) => new ApiError(422, 'invalid', detail, extra),
  invalidGps: (detail: string, extra: Record<string, unknown> = {}) => new ApiError(422, 'invalid_gps', detail, extra),
  payloadTooLarge: (detail: string) => new ApiError(413, 'payload_too_large', detail),
  conflict: (code: string, detail: string, extra: Record<string, unknown> = {}) => new ApiError(409, code, detail, extra),
  rateLimited: (detail = 'Too many requests') => new ApiError(429, 'rate_limited', detail),
  internal: (detail = 'Something went wrong') => new ApiError(500, 'internal_error', detail),
};
