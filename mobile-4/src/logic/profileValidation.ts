/**
 * Profile-building validation (onboarding "About you", saved to Exercise's
 * GET/PUT /api/me/profile-details). Pure functions, so the rules are the same everywhere and
 * unit-tested (profileValidation.test.mjs). Exercise re-validates; its field errors land on the
 * same fields (serverFieldErrors).
 *
 * Compulsory: full name, personal email, college email, phone, gender, date of birth, course.
 * Optional: CGPA — blank never blocks; if entered it must be a valid 0–10 score.
 * The college email is the address you signed in with (Exercise refuses any other), so it's shown,
 * not typed. Exercise keeps a date of birth, never an age: the age is worked out from it.
 */
export type DetailsForm = {
  full_name: string;
  personal_email: string;
  college_email: string;
  phone: string;
  gender: string;
  /** As typed: DD/MM/YYYY. */
  date_of_birth: string;
  course: string;
  cgpa: string;
};
export type DetailsField = keyof DetailsForm;
export type DetailsErrors = Partial<Record<DetailsField, string>>;

export const REQUIRED_FIELDS: DetailsField[] = ['full_name', 'personal_email', 'college_email', 'phone', 'gender', 'date_of_birth', 'course'];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const MIN_AGE = 16;
export const MAX_AGE = 99;

/** "+91 98765 43210", "098765-43210", "9876543210" → "+919876543210"; null if not a valid Indian mobile. */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  const local = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits.length === 11 && digits.startsWith('0') ? digits.slice(1) : digits;
  return /^[6-9]\d{9}$/.test(local) ? `+91${local}` : null;
}

/** Ends with one of the campus domains (e.g. iiserkol.ac.in); with none configured, any .ac.in address. */
export function isCollegeEmail(email: string, domains: string[]) {
  const e = email.trim().toLowerCase();
  if (!EMAIL.test(e)) return false;
  const host = e.split('@')[1];
  return domains.length ? domains.some((d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`)) : host.endsWith('.ac.in');
}

/** "DD/MM/YYYY" as you type it: digits only, slashes added. */
export function formatDobInput(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 8);
  return [d.slice(0, 2), d.slice(2, 4), d.slice(4)].filter(Boolean).join('/');
}

/** "DD/MM/YYYY" → "YYYY-MM-DD", or null when it isn't a real date. */
export function dobToIso(text: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const d = new Date(Date.UTC(+yyyy, +mm - 1, +dd));
  return d.getUTCFullYear() === +yyyy && d.getUTCMonth() === +mm - 1 && d.getUTCDate() === +dd ? `${yyyy}-${mm}-${dd}` : null;
}

/** "YYYY-MM-DD" → "DD/MM/YYYY" (prefilling the form); '' for anything else. */
export const dobFromIso = (iso: string | null | undefined) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split('-').reverse().join('/') : '');

/** Whole years from a "YYYY-MM-DD" birth date to `today`. */
export function ageOn(iso: string, today: Date): number {
  const [y, m, d] = iso.split('-').map(Number);
  const before = today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d);
  return today.getFullYear() - y - (before ? 1 : 0);
}

export function validateDetails(f: DetailsForm, today: Date = new Date()): DetailsErrors {
  const e: DetailsErrors = {};
  const name = f.full_name.trim();
  if (!name) e.full_name = 'Full name is required.';
  else if (name.length < 2 || !/[a-zA-ZÀ-ɏऀ-ॿ]/.test(name)) e.full_name = 'Enter your full name.';
  else if (name.length > 60) e.full_name = 'Keep it under 60 characters.';

  const personal = f.personal_email.trim().toLowerCase();
  const college = f.college_email.trim().toLowerCase();
  if (!personal) e.personal_email = 'Personal email is required.';
  else if (!EMAIL.test(personal)) e.personal_email = 'That doesn’t look like an email address.';
  else if (personal === college) e.personal_email = 'Use a personal address, different from your college email.';

  // Not editable: empty only when the account's address couldn't be loaded.
  if (!college) e.college_email = 'Your sign-in email couldn’t be loaded. Go back and try again.';

  if (!f.phone.trim()) e.phone = 'Phone number is required.';
  else if (!normalizePhone(f.phone)) e.phone = 'Enter a valid 10-digit mobile number.';

  if (!f.gender) e.gender = 'Pick one — “Prefer not to say” is fine.';

  const dob = dobToIso(f.date_of_birth);
  if (!f.date_of_birth.trim()) e.date_of_birth = 'Date of birth is required.';
  else if (!dob) e.date_of_birth = 'Enter a real date as DD/MM/YYYY.';
  else if (ageOn(dob, today) < MIN_AGE || ageOn(dob, today) > MAX_AGE) e.date_of_birth = `You must be ${MIN_AGE}–${MAX_AGE} to use Squirrel.`;

  if (!f.course.trim()) e.course = 'Course is required.';
  else if (f.course.trim().length > 60) e.course = 'Keep it under 60 characters.';

  const cg = f.cgpa.trim();
  if (cg) {
    if (!/^\d{1,2}(\.\d{1,2})?$/.test(cg)) e.cgpa = 'Use a number like 8.4 (up to 2 decimals).';
    else if (+cg < 0 || +cg > 10) e.cgpa = 'CGPA is on a 10-point scale.';
  }
  return e;
}

export const isComplete = (errors: DetailsErrors) => Object.keys(errors).length === 0;

/** The PUT /api/me/profile-details body for a valid form (Exercise works the age out itself). */
export function detailsBody(f: DetailsForm) {
  return {
    full_name: f.full_name.trim(),
    personal_email: f.personal_email.trim().toLowerCase(),
    college_email: f.college_email.trim().toLowerCase(),
    phone: normalizePhone(f.phone)!,
    gender: f.gender,
    date_of_birth: dobToIso(f.date_of_birth)!,
    course: f.course.trim(),
    cgpa: f.cgpa.trim() ? Number(f.cgpa) : null,
  };
}

const FIELDS = new Set<string>(REQUIRED_FIELDS.concat('cgpa'));

/**
 * Exercise's 422 (FastAPI: detail = [{ loc: ['body', field], msg }]) as errors on the form's own
 * fields. `age` (a sent age that disagrees) belongs to the date of birth. Empty when none map.
 */
export function serverFieldErrors(body: unknown): DetailsErrors {
  const detail = (body as { detail?: unknown } | null | undefined)?.detail;
  const out: DetailsErrors = {};
  if (!Array.isArray(detail)) return out;
  for (const d of detail as { loc?: unknown[]; msg?: unknown }[]) {
    const raw = Array.isArray(d?.loc) ? String(d.loc[d.loc.length - 1]) : '';
    const field = raw === 'age' ? 'date_of_birth' : raw;
    if (!FIELDS.has(field) || typeof d.msg !== 'string' || out[field as DetailsField]) continue;
    const msg = d.msg.replace(/^Value error, /, '');
    out[field as DetailsField] = msg.charAt(0).toUpperCase() + msg.slice(1) + (/[.!?]$/.test(msg) ? '' : '.');
  }
  return out;
}
