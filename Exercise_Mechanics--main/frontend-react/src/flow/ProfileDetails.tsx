/* ProfileDetails.tsx — sign-up page 2, shown right after the account is created on page 1. Same
   language as page 1: the logotype, a statement heading, numbered sections, pill actions. Every
   question is optional and the whole page can be skipped. Physique and habits sit behind their own
   consent box: the fields only appear once it is ticked, and only then are they sent. */
import { useId, useState, type ReactNode } from 'react'
import type { CachedUser } from './storage'
import {
  ACTIVITY_LEVEL_OPTIONS, ACTIVITY_OPTIONS, ALCOHOL_OPTIONS, BODY_TYPE_OPTIONS, DIET_OPTIONS, EMPTY_DETAILS,
  FITNESS_LEVEL_OPTIONS, GOAL_OPTIONS, SMOKING_OPTIONS, WORKOUT_TIME_OPTIONS,
  detailsErrors, detailsPayload, saveSignUpDetails, toggle,
  type DetailsDraft, type DetailsErrors, type Option,
} from './profileDetailsApi'
import { Eyebrow, PillButton, Wordmark } from './uiV2'

export function ProfileDetails({ user, onDone }: { user: CachedUser; onDone: () => void }) {
  const [draft, setDraft] = useState<DetailsDraft>(EMPTY_DETAILS)
  const [errors, setErrors] = useState<DetailsErrors>({})
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  async function finish() {
    const e = detailsErrors(draft)
    setErrors(e)
    if (Object.keys(e).length) return
    const payload = detailsPayload(draft)
    if (!payload) { onDone(); return } // nothing answered — same as skipping
    setSaving(true)
    setServerError(null)
    try {
      await saveSignUpDetails(user.user_id, payload)
      onDone()
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setSaving(false)
    }
  }

  return (
    <ProfileDetailsForm
      firstName={user.first_name} draft={draft} onDraft={setDraft} errors={errors}
      saving={saving} serverError={serverError} onFinish={finish} onSkip={onDone}
    />
  )
}

export type ProfileDetailsFormProps = {
  firstName: string
  draft: DetailsDraft; onDraft: (next: DetailsDraft) => void
  errors: DetailsErrors; saving: boolean; serverError: string | null
  onFinish: () => void; onSkip: () => void
}

export function ProfileDetailsForm(
  { firstName, draft, onDraft, errors, saving, serverError, onFinish, onSkip }: ProfileDetailsFormProps,
) {
  const set = <K extends keyof DetailsDraft>(key: K, value: DetailsDraft[K]) => onDraft({ ...draft, [key]: value })

  return (
    <div className="v2 v2-obc">
      <Wordmark />

      <div className="v2-obc__head">
        <Eyebrow>Step 2 of 2</Eyebrow>
        <h1 className="v2-obc__title">{firstName ? `Nice to meet you, ${firstName}` : 'Your training profile'}</h1>
        <p className="v2-obc__hint">All optional. It helps tailor your workouts, so skip anything you like.</p>
      </div>

      <form className="v2-obc__form" noValidate onSubmit={(e) => { e.preventDefault(); onFinish() }}>
        <Section index={1} title="Fitness" delay={160}>
          <div className="v2-pd__stack">
            <ChipGroup label="Fitness level" error={errors.fitness}>
              {FITNESS_LEVEL_OPTIONS.map((o) => (
                <Chip key={o.value} radio on={draft.fitnessLevel === o.value}
                  onClick={() => set('fitnessLevel', draft.fitnessLevel === o.value ? null : o.value)}>
                  {o.label}
                </Chip>
              ))}
            </ChipGroup>
            <div className="v2-grid">
              <SelectField label="How active are you day to day?" value={draft.activityLevel}
                options={ACTIVITY_LEVEL_OPTIONS} onChange={(v) => set('activityLevel', v)} />
              <SelectField label="Main goal" value={draft.primaryGoal}
                options={GOAL_OPTIONS} onChange={(v) => set('primaryGoal', v)} />
            </div>
          </div>
        </Section>

        <Section index={2} title="Activities" delay={240}>
          <ChipGroup label="What do you do, or want to do?">
            {ACTIVITY_OPTIONS.map((o) => (
              <Chip key={o.value} on={draft.activities.includes(o.value)}
                onClick={() => set('activities', toggle(draft.activities, o.value))}>
                {o.label}
              </Chip>
            ))}
          </ChipGroup>
        </Section>

        <Section index={3} title="Physique" delay={320}>
          <div className="v2-pd__stack">
            <Consent checked={draft.physiqueConsent} onChange={(v) => set('physiqueConsent', v)}
              title="Save my physique details"
              note="Private, used only to tailor workouts. Untick later and it's erased." />
            {draft.physiqueConsent && (
              <ChipGroup label="Body type" error={errors.physique}>
                {BODY_TYPE_OPTIONS.map((o) => (
                  <Chip key={o.value} radio on={draft.bodyType === o.value} onClick={() => set('bodyType', o.value)}>
                    {o.label}
                  </Chip>
                ))}
              </ChipGroup>
            )}
          </div>
        </Section>

        <Section index={4} title="Habits" delay={400}>
          <div className="v2-pd__stack">
            <Consent checked={draft.habitsConsent} onChange={(v) => set('habitsConsent', v)}
              title="Save my habits"
              note="Schedule, sleep, diet and lifestyle. Private, and erased if you untick later." />
            {draft.habitsConsent && (
              <>
                <ChipGroup label="When do you like to train?" error={errors.habits}>
                  {WORKOUT_TIME_OPTIONS.map((o) => (
                    <Chip key={o.value} on={draft.workoutTimes.includes(o.value)}
                      onClick={() => set('workoutTimes', toggle(draft.workoutTimes, o.value))}>
                      {o.label}
                    </Chip>
                  ))}
                </ChipGroup>
                <div className="v2-grid">
                  <NumberField label="Workouts per week (goal)" value={draft.workoutsPerWeek} error={errors.workoutsPerWeek}
                    placeholder="4" onChange={(v) => set('workoutsPerWeek', v)} />
                  <NumberField label="Sleep per night" unit="hrs" value={draft.sleepHours} error={errors.sleepHours}
                    placeholder="7.5" onChange={(v) => set('sleepHours', v)} />
                  <SelectField label="Diet" value={draft.diet} options={DIET_OPTIONS} onChange={(v) => set('diet', v)} />
                  <SelectField label="Smoking" value={draft.smoking} options={SMOKING_OPTIONS} onChange={(v) => set('smoking', v)} />
                  <SelectField label="Alcohol" value={draft.alcohol} options={ALCOHOL_OPTIONS} onChange={(v) => set('alcohol', v)} />
                </div>
              </>
            )}
          </div>
        </Section>

        {serverError && <div className="v2-server-err" role="alert">{serverError}</div>}

        <div className="v2-obc__actions">
          <PillButton variant="ghost" onClick={onSkip} disabled={saving}>Skip for now</PillButton>
          <PillButton type="submit" disabled={saving}>{saving ? 'Saving…' : 'Finish'}</PillButton>
        </div>

        <p className="v2-obc__trust">You can change these answers, or withdraw consent, at any time.</p>
      </form>
    </div>
  )
}

function Section({ index, title, delay, children }: { index: number; title: string; delay: number; children: ReactNode }) {
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

function ChipGroup({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <div className="v2-field" role="group" aria-label={label}>
      <span className="v2-field__label">{label}</span>
      <div className="v2-ph__chips">{children}</div>
      {error && <div className="v2-err">{error}</div>}
    </div>
  )
}

function Chip({ on, onClick, radio, children }: { on: boolean; onClick: () => void; radio?: boolean; children: ReactNode }) {
  return (
    <button type="button" className={`v2-libchip${on ? ' v2-libchip--active' : ''}`}
      role={radio ? 'radio' : undefined} aria-checked={radio ? on : undefined} aria-pressed={radio ? undefined : on}
      onClick={onClick}>
      {children}
    </button>
  )
}

function Consent({ checked, onChange, title, note }: { checked: boolean; onChange: (v: boolean) => void; title: string; note: string }) {
  return (
    <label className="v2-ph__toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <strong>{title}</strong>
        <span className="v2-pd__note"> {note}</span>
      </span>
    </label>
  )
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: Option[]; onChange: (v: string) => void }) {
  // Linked by id rather than wrapped, so the accessible name is the label alone, not every option.
  const id = useId()
  return (
    <div className="v2-field">
      <label className="v2-field__label" htmlFor={id}>{label}</label>
      <select id={id} className="v2-input v2-select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Skip</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <span className="v2-err" />
    </div>
  )
}

function NumberField(
  { label, value, error, unit, placeholder, onChange }:
  { label: string; value: string; error?: string; unit?: string; placeholder: string; onChange: (v: string) => void },
) {
  const id = useId()
  return (
    <div className="v2-field">
      <label className="v2-field__label" htmlFor={id}>{label}</label>
      <div className="v2-control">
        <input id={id} className={`v2-input${unit ? ' v2-input--unit' : ''}`} type="number" inputMode="decimal"
          value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        {unit && <span className="v2-unit" aria-hidden>{unit}</span>}
      </div>
      <span className="v2-err">{error ?? ''}</span>
    </div>
  )
}
