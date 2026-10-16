import assert from 'node:assert/strict';
import test from 'node:test';
import { ageOn, detailsBody, dobFromIso, dobToIso, formatDobInput, isCollegeEmail, isComplete, normalizePhone, REQUIRED_FIELDS, serverFieldErrors, validateDetails } from './profileValidation.ts';

const ok = { full_name: 'Aanya Sharma', personal_email: 'aanya@gmail.com', college_email: 'as21ms001@iiserkol.ac.in', phone: '98765 43210', gender: 'female', date_of_birth: '14/03/2005', course: 'BS-MS', cgpa: '' };
const TODAY = new Date(2026, 9, 6); // 6 Oct 2026

test('a complete form passes; CGPA can be blank', () => {
  assert.ok(isComplete(validateDetails(ok, TODAY)));
});

test('every compulsory field blocks completion when empty', () => {
  for (const f of REQUIRED_FIELDS) {
    const e = validateDetails({ ...ok, [f]: '' }, TODAY);
    assert.ok(e[f], `${f} should be required`);
    assert.equal(isComplete(e), false);
  }
});

test('optional CGPA: blank is fine, invalid values are not', () => {
  assert.equal(validateDetails({ ...ok, cgpa: '' }, TODAY).cgpa, undefined);
  assert.equal(validateDetails({ ...ok, cgpa: '8.45' }, TODAY).cgpa, undefined);
  assert.ok(validateDetails({ ...ok, cgpa: '10.5' }, TODAY).cgpa);
  assert.ok(validateDetails({ ...ok, cgpa: 'eight' }, TODAY).cgpa);
  assert.ok(validateDetails({ ...ok, cgpa: '8.456' }, TODAY).cgpa);
});

test('emails: personal must be valid and different; the college one is the sign-in address, any domain', () => {
  assert.ok(validateDetails({ ...ok, personal_email: 'nope' }, TODAY).personal_email);
  assert.ok(validateDetails({ ...ok, personal_email: ok.college_email }, TODAY).personal_email);
  // Code sign-in works for any address; Exercise requires the college email to be that address.
  assert.equal(validateDetails({ ...ok, college_email: 'aanya@outlook.com' }, TODAY).college_email, undefined);
  assert.ok(isCollegeEmail('x@students.iiserkol.ac.in', ['iiserkol.ac.in']));
  assert.equal(isCollegeEmail('x@iiserkol.ac.in.evil.com', ['iiserkol.ac.in']), false);
});

test('phone numbers normalise to +91 and reject bad ones', () => {
  assert.equal(normalizePhone('+91 98765-43210'), '+919876543210');
  assert.equal(normalizePhone('09876543210'), '+919876543210');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('5876543210'), null);
});

test('date of birth: typed as DD/MM/YYYY, a real date, 16 to 99 on the day', () => {
  assert.equal(formatDobInput('14032005'), '14/03/2005');
  assert.equal(formatDobInput('14/0'), '14/0');
  assert.equal(dobToIso('14/03/2005'), '2005-03-14');
  assert.equal(dobToIso('31/02/2005'), null);
  assert.equal(dobFromIso('2005-03-14'), '14/03/2005');
  assert.equal(dobFromIso(null), '');
  assert.equal(ageOn('2010-10-06', TODAY), 16); // birthday today
  assert.equal(ageOn('2010-10-07', TODAY), 15); // tomorrow
  assert.ok(validateDetails({ ...ok, date_of_birth: '07/10/2010' }, TODAY).date_of_birth);
  assert.equal(validateDetails({ ...ok, date_of_birth: '06/10/2010' }, TODAY).date_of_birth, undefined);
  assert.ok(validateDetails({ ...ok, date_of_birth: '30/02/2004' }, TODAY).date_of_birth);
});

test('the body Exercise gets: normalised, ISO birth date, no age', () => {
  assert.deepEqual(detailsBody({ ...ok, personal_email: ' Aanya@Gmail.com ', cgpa: '8.4' }), {
    full_name: 'Aanya Sharma', personal_email: 'aanya@gmail.com', college_email: 'as21ms001@iiserkol.ac.in', phone: '+919876543210',
    gender: 'female', date_of_birth: '2005-03-14', course: 'BS-MS', cgpa: 8.4,
  });
});

test("Exercise's 422s land on the form's fields", () => {
  const body = { detail: [
    { type: 'personal_email_same_as_college', loc: ['body', 'personal_email'], msg: 'use a personal address, different from your college email' },
    { type: 'age_out_of_range', loc: ['body', 'date_of_birth'], msg: 'you must be 16–99 to use Squirrel' },
    { type: 'value_error', loc: ['body', 'full_name'], msg: 'Value error, enter your full name' },
    { type: 'extra_forbidden', loc: ['body', 'nickname'], msg: 'Extra inputs are not permitted' },
  ] };
  assert.deepEqual(serverFieldErrors(body), {
    personal_email: 'Use a personal address, different from your college email.',
    date_of_birth: 'You must be 16–99 to use Squirrel.',
    full_name: 'Enter your full name.',
  });
  assert.deepEqual(serverFieldErrors({ detail: [{ loc: ['body', 'age'], msg: 'age comes from your date of birth' }] }), { date_of_birth: 'Age comes from your date of birth.' });
  assert.deepEqual(serverFieldErrors({ detail: { code: 'x', message: 'y' } }), {});
});
