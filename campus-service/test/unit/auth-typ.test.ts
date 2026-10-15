import { describe, it, expect } from 'vitest';
import { verifyBearer } from '../../src/auth/jwt.js';
import { mintDevToken } from '../../src/auth/dev-token.js';

/** Only user access tokens are people: Exercise's service tokens (typ "service") never provision a user. */
describe('verifyBearer — token type', () => {
  it('accepts typ "access" and untyped tokens', async () => {
    expect((await verifyBearer(await mintDevToken('u_typ_access', { typ: 'access' }))).userId).toBe('u_typ_access');
    expect((await verifyBearer(await mintDevToken('u_typ_none'))).userId).toBe('u_typ_none');
  });

  it('refuses a service token', async () => {
    await expect(verifyBearer(await mintDevToken('exercise_module', { typ: 'service' }))).rejects.toThrow(/not an access token/);
  });
});
