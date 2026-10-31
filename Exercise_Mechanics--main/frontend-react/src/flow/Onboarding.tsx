/* Onboarding.tsx — first-time profile capture in the landing's language: one
   centred column under the Exercise Mechanics logotype. A statement heading, three
   numbered sections (the numbering IS the progress — no side rail), pill
   actions, and a quiet privacy line to close. On submit it POSTs to the
   backend (which mints the user_id + writes profile.json), caches the
   identity locally, and hands the new user to sign-up page 2 (ProfileDetails). */
import { useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createUser, saveUser, type CachedUser, type OnboardingForm } from './storage'
import { Eyebrow, PillButton, Wordmark } from './uiV2'

type FormState = {
  first_name: string; last_name: string; gender: string; date_of_birth: string
  height_cm: string; weight_kg: string; mobile: string; email: string
}

const EMPTY: FormState = {
  first_name: '', last_name: '', gender: '', date_of_birth: '',
  height_cm: '', weight_kg: '', mobile: '', email: '',
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MOBILE_RE = /^[+]?[\d\s-]{7,}$/

function validate(f: FormState): Partial<Record<keyof FormState, string>> {
  const e: Partial<Record<keyof FormState, string>> = {}
  if (!f.first_name.trim()) e.first_name = 'Required'
  if (!f.last_name.trim()) e.last_name = 'Required'
  if (!f.gender) e.gender = 'Required'
  if (!f.date_of_birth) e.date_of_birth = 'Required'
  const h = Number(f.height_cm)
  if (!f.height_cm || !Number.isFinite(h) || h <= 0 || h >= 300) e.height_cm = 'Enter a valid height'
  const w = Number(f.weight_kg)
  if (!f.weight_kg || !Number.isFinite(w) || w <= 0 || w >= 500) e.weight_kg = 'Enter a valid weight'
  if (!MOBILE_RE.test(f.mobile.trim())) e.mobile = 'Enter a valid number'
  if (!EMAIL_RE.test(f.email.trim())) e.email = 'Enter a valid email'
  return e
}

export function Onboarding(
  { onDone, onBack }: { onDone: (u: CachedUser) => void; onBack: () => void },
) {
  const [f, setF] = useState<FormState>(EMPTY)
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({})
  const [submitting, setSubmitting] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const set = (k: keyof FormState) => (v: string) => setF((s) => ({ ...s, [k]: v }))

  async function submit(ev: FormEvent) {
    ev.preventDefault()
    const e = validate(f)
    setErrors(e)
    if (Object.keys(e).length) return
    const payload: OnboardingForm = {
      first_name: f.first_name.trim(),
      last_name: f.last_name.trim(),
      gender: f.gender,
      height_cm: Number(f.height_cm),
      weight_kg: Number(f.weight_kg),
      date_of_birth: f.date_of_birth,
      mobile: f.mobile.trim(),
      email: f.email.trim(),
    }
    setSubmitting(true)
    setServerError(null)
    try {
      const user = await createUser(payload)
      saveUser(user)
      onDone(user)
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setSubmitting(false)
    }
  }

  return (
    <div className="v2 v2-obc">
      <Wordmark />

      <div className="v2-obc__head">
        <Eyebrow>Step 1 of 2</Eyebrow>
        <h1 className="v2-obc__title">Build your profile</h1>
        <p className="v2-obc__hint">Under a minute. All fields required.</p>
      </div>

      <form className="v2-obc__form" onSubmit={submit}>
        <Section index={1} title="Identity" delay={160}>
          <div className="v2-grid">
            <Field label="First name" error={errors.first_name}>
              <input className="v2-input" value={f.first_name} onChange={(e) => set('first_name')(e.target.value)}
                placeholder="Alex" autoComplete="given-name" />
            </Field>
            <Field label="Last name" error={errors.last_name}>
              <input className="v2-input" value={f.last_name} onChange={(e) => set('last_name')(e.target.value)}
                placeholder="Taylor" autoComplete="family-name" />
            </Field>
            <Field label="Date of birth" error={errors.date_of_birth}>
              <DateField value={f.date_of_birth} onChange={set('date_of_birth')} />
            </Field>
            <Field label="Gender" error={errors.gender}>
              <select className="v2-input v2-select" value={f.gender} onChange={(e) => set('gender')(e.target.value)}>
                <option value="" disabled>Select…</option>
                <option value="female">Female</option>
                <option value="male">Male</option>
                <option value="non_binary">Non-binary</option>
                <option value="undisclosed">Prefer not to say</option>
              </select>
            </Field>
          </div>
        </Section>

        <Section index={2} title="Body metrics" delay={240}>
          <div className="v2-grid">
            <Field label="Height" error={errors.height_cm} unit="cm">
              <input className="v2-input v2-input--unit" type="number" inputMode="decimal" value={f.height_cm}
                onChange={(e) => set('height_cm')(e.target.value)} placeholder="178" min={1} max={299} />
            </Field>
            <Field label="Weight" error={errors.weight_kg} unit="kg">
              <input className="v2-input v2-input--unit" type="number" inputMode="decimal" value={f.weight_kg}
                onChange={(e) => set('weight_kg')(e.target.value)} placeholder="74" min={1} max={499} />
            </Field>
          </div>
        </Section>

        <Section index={3} title="Contact" delay={320}>
          <div className="v2-grid">
            <Field label="Mobile number" error={errors.mobile}>
              <input className="v2-input" type="tel" value={f.mobile} onChange={(e) => set('mobile')(e.target.value)}
                placeholder="+91 90000 00000" autoComplete="tel" />
            </Field>
            <Field label="Email address" error={errors.email}>
              <input className="v2-input" type="email" value={f.email} onChange={(e) => set('email')(e.target.value)}
                placeholder="you@example.com" autoComplete="email" />
            </Field>
          </div>
        </Section>

        {serverError && <div className="v2-server-err">{serverError}</div>}

        <div className="v2-obc__actions">
          <PillButton variant="ghost" onClick={onBack}>Back</PillButton>
          <PillButton type="submit" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create profile'}
          </PillButton>
        </div>

        <p className="v2-obc__trust">
          <LockGlyph />
          Stored on your profile. Never shared.
        </p>
      </form>
    </div>
  )
}

/* A numbered, titled section — the numbering carries the flow's sequence. */
function Section(
  { index, title, delay, children }:
  { index: number; title: string; delay: number; children: ReactNode },
) {
  return (
    <section className="v2-sec" style={{ animationDelay: `${delay}ms` }}>
      <div className="v2-sec__head">
        <span className="v2-sec__idx">0{index}</span>
        <span className="v2-sec__title">{title}</span>
        <span className="v2-sec__rule" />
      </div>
      {children}
    </section>
  )
}

/* Segmented date input (DD / MM / YYYY) that auto-advances as you type — fill the
   day and focus jumps to month, then year; Backspace on an empty segment hops back.
   Emits an ISO yyyy-mm-dd string only once the three parts form a real, non-future
   date; otherwise emits '' so validation flags it. */
function DateField({ value, onChange }: { value: string; onChange: (iso: string) => void }) {
  const [d, setD] = useState(value ? value.slice(8, 10) : '')
  const [m, setM] = useState(value ? value.slice(5, 7) : '')
  const [y, setY] = useState(value ? value.slice(0, 4) : '')
  const dRef = useRef<HTMLInputElement>(null)
  const mRef = useRef<HTMLInputElement>(null)
  const yRef = useRef<HTMLInputElement>(null)

  const digits = (s: string) => s.replace(/\D/g, '')

  function emit(dd: string, mm: string, yy: string) {
    if (!dd || !mm || yy.length !== 4) { onChange(''); return }
    const iso = `${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`
    const dt = new Date(`${iso}T00:00:00`)
    const real =
      !Number.isNaN(dt.getTime()) &&
      dt.getFullYear() === Number(yy) &&
      dt.getMonth() + 1 === Number(mm) &&
      dt.getDate() === Number(dd) &&
      dt.getTime() <= Date.now() &&
      Number(yy) >= 1900
    onChange(real ? iso : '')
  }

  // Advance when the segment is full, or when it can't grow (e.g. day "4" can't be
  // a two-digit day, month "2" can't start a two-digit month).
  const handleD = (v: string) => {
    const x = digits(v).slice(0, 2)
    setD(x); emit(x, m, y)
    if (x.length === 2 || (x.length === 1 && Number(x) > 3)) mRef.current?.focus()
  }
  const handleM = (v: string) => {
    const x = digits(v).slice(0, 2)
    setM(x); emit(d, x, y)
    if (x.length === 2 || (x.length === 1 && Number(x) > 1)) yRef.current?.focus()
  }
  const handleY = (v: string) => { const x = digits(v).slice(0, 4); setY(x); emit(d, m, x) }

  const backTo = (e: KeyboardEvent, cur: string, prev: RefObject<HTMLInputElement | null>) => {
    if (e.key === 'Backspace' && cur === '') prev.current?.focus()
  }

  return (
    <div className="v2-date">
      <input ref={dRef} className="v2-date__seg" inputMode="numeric" placeholder="DD" value={d}
        onChange={(e) => handleD(e.target.value)} aria-label="Day" />
      <span className="v2-date__sep">/</span>
      <input ref={mRef} className="v2-date__seg" inputMode="numeric" placeholder="MM" value={m}
        onChange={(e) => handleM(e.target.value)} onKeyDown={(e) => backTo(e, m, dRef)} aria-label="Month" />
      <span className="v2-date__sep">/</span>
      <input ref={yRef} className="v2-date__seg v2-date__seg--year" inputMode="numeric" placeholder="YYYY" value={y}
        onChange={(e) => handleY(e.target.value)} onKeyDown={(e) => backTo(e, y, mRef)} aria-label="Year" />
    </div>
  )
}

/* Labelled field: micro-label (lights up on focus via :focus-within), an optional
   unit chip inside the control, and an error line that reserves its own height. */
function Field(
  { label, error, unit, children }:
  { label: string; error?: string; unit?: string; children: ReactNode },
) {
  return (
    <label className="v2-field">
      <span className="v2-field__label">{label}</span>
      <div className="v2-control">
        {children}
        {unit && <span className="v2-unit">{unit}</span>}
      </div>
      <span className="v2-err">{error || ' '}</span>
    </label>
  )
}

/* Padlock glyph for the trust line — signals the "stored privately" assurance. */
function LockGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.4" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </svg>
  )
}
