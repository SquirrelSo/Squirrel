/**
 * Claims read from the app's own access token, without verifying: the server verifies every
 * request, and the app only uses these to recognise its own rows and to word its screens.
 */
export function jwtClaims(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const json = decodeURIComponent(
      Array.from(globalThis.atob(b64), (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''),
    );
    const claims: unknown = JSON.parse(json);
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The signed-in user's id is the token's `sub` claim. */
export function jwtSubject(token: string): string | null {
  const sub = jwtClaims(token)?.sub;
  return typeof sub === 'string' && sub ? sub : null;
}

/**
 * The account has proved its email address: the Exercise backend sets `ev: true` once the person
 * has signed in with an emailed code. Access-code accounts start without it.
 */
export function jwtEmailVerified(token: string): boolean {
  return jwtClaims(token)?.ev === true;
}
