import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer } from 'node:buffer';
import { jwtEmailVerified, jwtSubject } from '../auth/jwt.ts';

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (claims) => `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(claims)}.sig`;
const sub = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

test('ev: true marks a verified account; anything else does not', () => {
  assert.equal(jwtEmailVerified(token({ sub, typ: 'access', ev: true })), true);
  assert.equal(jwtEmailVerified(token({ sub, typ: 'access' })), false, 'access-code accounts carry no ev');
  assert.equal(jwtEmailVerified(token({ sub, ev: 'true' })), false);
  assert.equal(jwtEmailVerified('not-a-token'), false);
});

test('subject is still read the same way', () => {
  assert.equal(jwtSubject(token({ sub, ev: true })), sub);
  assert.equal(jwtSubject(token({ sub: '' })), null);
  assert.equal(jwtSubject(`x.${Buffer.from('[1]').toString('base64url')}.y`), null);
});
