/**
 * Rules for the access-code sign-up form (non-campus accounts): field checks, phone normalising,
 * and which step a server error belongs to. Pure, so it's unit-tested without the app.
 */
export type SignupField = 'email' | 'full_name' | 'phone' | 'access_code';
export type SignupStep = 1 | 2 | 3 | 4;

/** The step that asks for each field. */
export const STEP_OF: Record<SignupField, SignupStep> = { email: 1, full_name: 2, phone: 3, access_code: 4 };

/** A plausible email shape. The server applies the exact rules. */
export const looksLikeEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

/** Campus sign-up is limited to institutional emails. The backend enforces the exact domains. */
export const isAcademicEmail = (e: string) =>
  /^[^\s@]+@([a-z0-9-]+\.)*[a-z0-9-]+\.ac\.in$/i.test(e.trim());

/** Asking for a sign-in code found no account for a non-campus address. */
export class NoAccountError extends Error {}

/**
 * `POST /api/auth/email/start` answered 403: the address has no account and isn't on the campus
 * allow-list, so the server refused it as a new sign-up. For a campus address its message ("open to
 * … only") is right. Anyone else was trying to sign in, so say so: account lookups are exact, and
 * john.doe@gmail.com and johndoe@gmail.com are different accounts here.
 */
export function emailStartRefused(email: string, serverMessage: string): Error {
 if (isAcademicEmail(email)) return new Error(serverMessage || 'Use your college email (ending in .ac.in).');
 return new NoAccountError(
   `No account uses ${email.trim()}. Check it's exactly the address you signed up with — dots and anything after a + count. New here without a campus email? Sign up with an access code.`,
 );
}

/** "  Asha   Rao " → { first_name: 'Asha', last_name: 'Rao' }; one word → empty last name. */
/** A typed Indian mobile number in any common shape -> +91XXXXXXXXXX, or null if it is not one. */
export function normalizeIndianMobile(raw: string): string | null {
  const compact = raw.trim().replace(/[\s\-().]/g, '');
  const m = /^(?:\+91|91|0)?([6-9]\d{9})$/.exec(compact);
  return m ? `+91${m[1]}` : null;
}
export function splitFullName(full: string): { first_name: string; last_name: string } {
 const words = full.trim().split(/\s+/).filter(Boolean);
 return { first_name: words[0] ?? '', last_name: words.slice(1).join(' ') };
}

/** A sign-up failure, with the field to send the person back to (null: stay where they are). */
export class SignupError extends Error {
 field: SignupField | null;
 /** The email already has an account: offer to sign in instead. */
 existingAccount: boolean;
 constructor(message: string, field: SignupField | null, existingAccount = false) {
   super(message);
   this.field = field;
   this.existingAccount = existingAccount;
 }
}

const FIELD_MESSAGE: Record<SignupField, string> = {
 email: 'That email address doesn\'t look right. Check it and try again.',
 full_name: 'Enter your full name.',
 phone: 'Enter a 10-digit Indian mobile number, like 98300 41275.',
 access_code: 'The access code is six digits.',
};

const isField = (v: unknown): v is SignupField => typeof v === 'string' && v in STEP_OF;

/**
 * Map a failed `POST /api/auth/signup/access-code` to wording and a step.
 *   409 → the email has an account · 422 → the field FastAPI names · 403 → a campus address or the code
 *   429 / network / anything else → stay on the current step with the server's message.
 */
export function classifySignupError(status: number, body: unknown, message: string): SignupError {
 const detail = (body as { detail?: unknown } | undefined)?.detail;
 if (status === 409) return new SignupError('An account with this email already exists. Sign in with an emailed code instead.', 'email', true);
 if (status === 422) {
   if (Array.isArray(detail)) {
     const field = detail.map((d: { loc?: unknown[] }) => d?.loc?.[d.loc.length - 1]).find(isField);
     if (field) return new SignupError(FIELD_MESSAGE[field], field);
   }
   if (typeof detail === 'string' && /name/i.test(detail)) return new SignupError(FIELD_MESSAGE.full_name, 'full_name');
   return new SignupError(typeof detail === 'string' ? detail : 'Check your details and try again.', null);
 }
 if (status === 403) {
   if (typeof detail === 'string' && /institute/i.test(detail)) return new SignupError('That\'s a campus address. Use the institute email sign-in instead.', 'email');
   return new SignupError('That access code didn\'t work. Check it and try again.', 'access_code');
 }
 if (status === 0) return new SignupError('Can\'t reach the server. Check your connection and try again.', null);
 return new SignupError(message || 'Sign-up failed. Try again in a moment.', null);
}