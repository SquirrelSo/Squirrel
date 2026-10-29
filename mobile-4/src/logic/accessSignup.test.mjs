import assert from 'node:assert/strict';
import test from 'node:test';
import { classifySignupError, emailStartRefused, looksLikeEmail, NoAccountError, normalizeIndianMobile, splitFullName, STEP_OF } from './accessSignup.ts';

test('phone numbers are normalised the way people type them', () => {
  for (const raw of ['9830041275', '98300 41275', '98300-41275', '+91 98300 41275', '+919830041275', '919830041275', '09830041275', ' (983) 004-1275 ']) {
    assert.equal(normalizeIndianMobile(raw), '+919830041275', raw);
  }
  assert.equal(normalizeIndianMobile('9123456789'), '+919123456789', 'a number that starts with 91 is not a prefix');
});

test('phone numbers that are not Indian mobiles are refused', () => {
  for (const raw of ['', '12345', '5830041275', '+1 415 555 0100', '98300412750', '+44 7700 900123', 'abcdefghij']) {
    assert.equal(normalizeIndianMobile(raw), null, raw);
  }
});

test('email shape and name split', () => {
  assert.ok(looksLikeEmail(' asha.rao@gmail.com '));
  assert.ok(!looksLikeEmail('asha@gmail'));
  assert.ok(!looksLikeEmail('asha rao@gmail.com'));
  assert.deepEqual(splitFullName('  Asha   Rao  Sen '), { first_name: 'Asha', last_name: 'Rao Sen' });
  assert.deepEqual(splitFullName('Asha'), { first_name: 'Asha', last_name: '' });
});

test('server errors send the person back to the right step', () => {
  const taken = classifySignupError(409, { detail: 'An account with this email already exists. Sign in instead.' }, '');
  assert.equal(STEP_OF[taken.field], 1);
  assert.equal(taken.existingAccount, true);

  const badEmail = classifySignupError(422, { detail: [{ loc: ['body', 'email'], msg: 'String should match pattern' }] }, 'email: String should match pattern');
  assert.equal(badEmail.field, 'email');
  assert.ok(!badEmail.message.includes('pattern'), 'no raw validator text');

  assert.equal(classifySignupError(422, { detail: [{ loc: ['body', 'phone'], msg: 'x' }] }, '').field, 'phone');
  assert.equal(classifySignupError(422, { detail: 'Enter your full name.' }, '').field, 'full_name');
  assert.equal(classifySignupError(403, { detail: 'Use the institute email sign-in option.' }, '').field, 'email');
  assert.equal(classifySignupError(403, { detail: 'Sign-up failed. Check your details and try again.' }, '').field, 'access_code');

  const slow = classifySignupError(429, { detail: 'Too many attempts. Try again in 12 minutes.' }, 'Too many attempts. Try again in 12 minutes.');
  assert.equal(slow.field, null);
  assert.match(slow.message, /Too many attempts/);
  assert.equal(classifySignupError(0, undefined, 'Network error').field, null);
});

test('a refused code request for a non-campus address says no account matched', () => {
  const gmail = emailStartRefused(' johndoe@gmail.com ', 'Sign-up is open to .ac.in email addresses only.');
  assert.ok(gmail instanceof NoAccountError);
  assert.match(gmail.message, /No account uses johndoe@gmail\.com\./);
  assert.ok(!/\.ac\.in/.test(gmail.message), 'no campus-only wording for someone signing in');

  const campus = emailStartRefused('asha@iitb.ac.in', 'Sign-up is open to iiserkol.ac.in email addresses only.');
  assert.ok(!(campus instanceof NoAccountError));
  assert.equal(campus.message, 'Sign-up is open to iiserkol.ac.in email addresses only.');
});
