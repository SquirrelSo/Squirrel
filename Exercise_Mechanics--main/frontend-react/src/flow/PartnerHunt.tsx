/* PartnerHunt.tsx — find people to train with, behind the Run Module's XP gate.

   The container (PartnerHunt) owns loading and saving; everything it renders is a presentational
   component driven by props, so each state — locked, XP service down, setup, board — renders in
   tests without a server. Which state shows is decided by partnerView() in partnerHunt.ts. */
import { useEffect, useState, type ReactNode } from 'react'
import { Icon } from '../tokens'
import {
  ACTIVITY_OPTIONS, DEFAULT_PREFERENCES, GENDER_OPTIONS, MAX_PARTNER_AGE, MIN_PARTNER_AGE, MODE_OPTIONS,
  TIME_OPTIONS, blockPartner, fetchPartnerMatches, fetchPartnerStatus, partnerView, preferenceErrors,
  savePartnerPreferences, toggle,
  type PartnerMatch, type PartnerPreferences, type PartnerStatus, type PartnerView, type PreferenceErrors,
} from './partnerHuntApi'

const activityLabel = (v: string) => ACTIVITY_OPTIONS.find((o) => o.value === v)?.label ?? v
const timeLabel = (v: string) => TIME_OPTIONS.find((o) => o.value === v)?.label ?? v
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/* ── container ─────────────────────────────────────────────────────────────────────────────── */

export function PartnerHunt({ userId }: { userId: string }) {
  const [status, setStatus] = useState<PartnerStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [matches, setMatches] = useState<PartnerMatch[] | null>(null)
  const [matchesError, setMatchesError] = useState<string | null>(null)
  const [draft, setDraft] = useState<PartnerPreferences>(DEFAULT_PREFERENCES)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showErrors, setShowErrors] = useState(false)
  // Bumped to reload status (and, on the board, matches): after a save, or on "Try again".
  const [reload, setReload] = useState(0)

  // Same shape as the other screens' loaders: state is only set from the async callback, and a
  // response that arrives after a newer request (or after unmount) is dropped.
  useEffect(() => {
    let cancelled = false
    fetchPartnerStatus(userId)
      .then((next) => {
        if (cancelled) return
        setStatus(next)
        setLoadError(null)
        if (next.preferences) setDraft({ ...next.preferences, city: next.preferences.city ?? '' })
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Could not load Partner Hunt.')
      })
    return () => { cancelled = true }
  }, [userId, reload])

  const view = status ? partnerView(status) : null
  const onBoard = view?.kind === 'board'

  useEffect(() => {
    if (!onBoard) return
    let cancelled = false
    fetchPartnerMatches(userId)
      .then((next) => {
        if (cancelled) return
        setMatches(next)
        setMatchesError(null)
      })
      .catch((e: unknown) => {
        if (!cancelled) setMatchesError(e instanceof Error ? e.message : 'Could not load matches.')
      })
    return () => { cancelled = true }
  }, [userId, onBoard, reload])

  const save = async () => {
    setShowErrors(true)
    if (Object.keys(preferenceErrors(draft)).length > 0) return
    setSaving(true)
    setSaveError(null)
    try {
      await savePartnerPreferences(userId, draft)
      setEditing(false)
      setShowErrors(false)
      setReload((n) => n + 1)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not save your preferences.')
    } finally {
      setSaving(false)
    }
  }

  const block = async (target: PartnerMatch) => {
    try {
      await blockPartner(userId, target.user_id)
      setMatches((current) => current?.filter((m) => m.user_id !== target.user_id) ?? null)
    } catch (e) {
      setMatchesError(e instanceof Error ? e.message : 'Could not block that member.')
    }
  }

  return (
    <PartnerHuntScreen
      view={view}
      loadError={loadError}
      onRetry={() => setReload((n) => n + 1)}
      draft={draft}
      onDraft={setDraft}
      errors={showErrors ? preferenceErrors(draft) : {}}
      saving={saving}
      saveError={saveError}
      onSave={save}
      editing={editing}
      onEdit={setEditing}
      hasSavedPreferences={Boolean(status?.preferences)}
      matches={matches}
      matchesError={matchesError}
      onBlock={block}
    />
  )
}

/* ── screen ────────────────────────────────────────────────────────────────────────────────── */

export type PartnerHuntScreenProps = {
  view: PartnerView | null
  loadError: string | null
  onRetry: () => void
  draft: PartnerPreferences
  onDraft: (next: PartnerPreferences) => void
  errors: PreferenceErrors
  saving: boolean
  saveError: string | null
  onSave: () => void
  editing: boolean
  onEdit: (editing: boolean) => void
  hasSavedPreferences: boolean
  matches: PartnerMatch[] | null
  matchesError: string | null
  onBlock: (match: PartnerMatch) => void
}

export function PartnerHuntScreen(p: PartnerHuntScreenProps) {
  const form = (title: string, note: string) => (
    <PreferencesForm
      title={title} note={note} draft={p.draft} onDraft={p.onDraft} errors={p.errors}
      saving={p.saving} saveError={p.saveError} onSave={p.onSave}
      onCancel={p.editing ? () => p.onEdit(false) : undefined}
    />
  )

  let body
  if (p.loadError) {
    body = <Panel tone="red" title="Partner Hunt didn't load" text={p.loadError} action={{ label: 'Try again', onClick: p.onRetry }} />
  } else if (!p.view) {
    body = <div className="v2-ph__muted">Loading…</div>
  } else if (p.view.kind === 'age_restricted') {
    body = <Panel tone="neutral" title="Partner Hunt is for members 18 and over"
      text="It introduces you to people you may meet in person, so it needs a date of birth on your profile showing you're 18 or older." />
  } else if (p.view.kind === 'xp_unavailable') {
    body = <>
      <Panel tone="amber" title="We couldn't check your XP"
        text="The XP service isn't responding right now. This isn't something you need to fix — try again shortly."
        action={{ label: 'Try again', onClick: p.onRetry }} />
      {form('Your preferences', 'You can still set these up now.')}
    </>
  } else if (p.view.kind === 'locked') {
    body = <>
      <XpGatePanel view={p.view} />
      {form(p.hasSavedPreferences ? 'Your preferences' : 'Set up while you unlock',
        "Save these now and you'll appear to other members the moment you reach the XP needed.")}
    </>
  } else if (p.view.kind === 'setup') {
    body = form('Tell us who you want to train with',
      'You can only browse while you’re visible to others — people see you the same way you see them.')
  } else {
    body = <>
      {p.editing
        ? form('Edit your preferences', 'Changes apply to your board and to who can see you.')
        : <div className="v2-ph__barrow">
            <span className="v2-ph__muted">Matched on what you both asked for — nobody sees you who you'd have excluded.</span>
            <button className="v2-btn v2-btn--ghost v2-btn--sm" onClick={() => p.onEdit(true)}>Edit preferences</button>
          </div>}
      <PartnerBoard matches={p.matches} error={p.matchesError} onBlock={p.onBlock} />
    </>
  }

  return (
    <div className="v2-ph">
      <div className="v2-hhead">
        <h1 className="v2-htitle">Partner Hunt</h1>
        <p className="v2-hsub">Find people to train with.</p>
      </div>
      {body}
    </div>
  )
}

/* ── pieces ────────────────────────────────────────────────────────────────────────────────── */

function Panel({ tone, title, text, action }: {
  tone: 'red' | 'amber' | 'neutral'; title: string; text: string; action?: { label: string; onClick: () => void }
}) {
  return (
    <div className={`v2-hcard v2-ph__panel v2-ph__panel--${tone}`} role="status">
      <div className="v2-ph__paneltitle">{title}</div>
      <p className="v2-ph__muted">{text}</p>
      {action && <div><button className="v2-btn v2-btn--ghost v2-btn--sm" onClick={action.onClick}>{action.label}</button></div>}
    </div>
  )
}

export function XpGatePanel({ view }: { view: Extract<PartnerView, { kind: 'locked' }> }) {
  return (
    <div className="v2-hcard v2-ph__gate" role="status">
      <span className="v2-hcard__label">Unlocks at {view.minXp} XP</span>
      <div className="v2-ph__xp">
        <span className="v2-ph__xpnum">{view.xp}</span>
        <span className="v2-ph__xpof">/ {view.minXp} XP</span>
      </div>
      <div className="v2-ph__bar" role="progressbar" aria-valuemin={0} aria-valuemax={view.minXp} aria-valuenow={view.xp}>
        <div className="v2-ph__barfill" style={{ width: `${Math.round(view.progress * 100)}%` }} />
      </div>
      <p className="v2-ph__muted">
        {view.remaining} XP to go. XP comes from the activity you log in the app.
      </p>
    </div>
  )
}

export function PreferencesForm({ title, note, draft, onDraft, errors, saving, saveError, onSave, onCancel }: {
  title: string; note: string
  draft: PartnerPreferences; onDraft: (next: PartnerPreferences) => void
  errors: PreferenceErrors; saving: boolean; saveError: string | null
  onSave: () => void; onCancel?: () => void
}) {
  const set = <K extends keyof PartnerPreferences>(key: K, value: PartnerPreferences[K]) => onDraft({ ...draft, [key]: value })
  const age = (key: 'partner_age_min' | 'partner_age_max', raw: string) =>
    set(key, raw === '' ? Number.NaN : Math.trunc(Number(raw)))

  return (
    <form className="v2-hcard v2-ph__form" onSubmit={(e) => { e.preventDefault(); onSave() }} noValidate>
      <div className="v2-ph__paneltitle">{title}</div>
      <p className="v2-ph__muted">{note}</p>

      <label className="v2-ph__toggle">
        <input type="checkbox" checked={draft.visible} onChange={(e) => set('visible', e.target.checked)} />
        <span>
          <strong>Show me in Partner Hunt</strong>
          <span className="v2-ph__muted"> — turn off to hide yourself. While hidden you can't browse either.</span>
        </span>
      </label>

      <Group label="Activities" error={errors.activities}>
        {ACTIVITY_OPTIONS.map((o) => (
          <Chip key={o.value} on={draft.activities.includes(o.value)} onClick={() => set('activities', toggle(draft.activities, o.value))}>
            {o.label}
          </Chip>
        ))}
      </Group>

      <Group label="Train together">
        {MODE_OPTIONS.map((o) => (
          <Chip key={o.value} on={draft.mode === o.value} onClick={() => set('mode', o.value)} radio>{o.label}</Chip>
        ))}
      </Group>

      {draft.mode !== 'remote' && (
        <div className="v2-field v2-ph__field">
          <label className="v2-field__label" htmlFor="ph-city">City</label>
          <input id="ph-city" className="v2-input" value={draft.city ?? ''} maxLength={60}
            placeholder="e.g. Pune" onChange={(e) => set('city', e.target.value)} />
          <span className="v2-ph__hint">Only your city is shared, and only with people who'd meet in person — never your location.</span>
          <div className="v2-err">{errors.city ?? ''}</div>
        </div>
      )}

      <Group label="When you train" error={errors.preferred_times}>
        {TIME_OPTIONS.map((o) => (
          <Chip key={o.value} on={draft.preferred_times.includes(o.value)} onClick={() => set('preferred_times', toggle(draft.preferred_times, o.value))}>
            {o.label}
          </Chip>
        ))}
      </Group>

      <Group label="Partner" hint={draft.partner_genders.length === 0
        ? 'Anyone. Pick options to narrow it down.'
        : "Only the people you picked — and members who haven't shared their gender won't appear."}>
        {GENDER_OPTIONS.map((o) => (
          <Chip key={o.value} on={draft.partner_genders.includes(o.value)} onClick={() => set('partner_genders', toggle(draft.partner_genders, o.value))}>
            {o.label}
          </Chip>
        ))}
      </Group>

      <div className="v2-field v2-ph__field">
        <span className="v2-field__label">Partner age</span>
        <div className="v2-ph__ages">
          <input aria-label="Minimum partner age" className="v2-input" type="number" inputMode="numeric"
            min={MIN_PARTNER_AGE} max={MAX_PARTNER_AGE}
            value={Number.isNaN(draft.partner_age_min) ? '' : draft.partner_age_min}
            onChange={(e) => age('partner_age_min', e.target.value)} />
          <span className="v2-ph__muted">to</span>
          <input aria-label="Maximum partner age" className="v2-input" type="number" inputMode="numeric"
            min={MIN_PARTNER_AGE} max={MAX_PARTNER_AGE}
            value={Number.isNaN(draft.partner_age_max) ? '' : draft.partner_age_max}
            onChange={(e) => age('partner_age_max', e.target.value)} />
        </div>
        <div className="v2-err">{errors.age ?? ''}</div>
      </div>

      {saveError && <div className="v2-err" role="alert">{saveError}</div>}
      <div className="v2-ph__actions">
        {onCancel && <button type="button" className="v2-btn v2-btn--ghost v2-btn--sm" onClick={onCancel}>Cancel</button>}
        <button type="submit" className="v2-btn v2-btn--primary v2-btn--sm" disabled={saving}>
          {saving ? 'Saving…' : 'Save preferences'}
        </button>
      </div>
    </form>
  )
}

function Group({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="v2-field v2-ph__field" role="group" aria-label={label}>
      <span className="v2-field__label">{label}</span>
      <div className="v2-ph__chips">{children}</div>
      {hint && <span className="v2-ph__hint">{hint}</span>}
      {error !== undefined && <div className="v2-err">{error}</div>}
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

export function PartnerBoard({ matches, error, onBlock }: {
  matches: PartnerMatch[] | null; error: string | null; onBlock: (match: PartnerMatch) => void
}) {
  if (error) return <div className="v2-err" role="alert">{error}</div>
  if (!matches) return <div className="v2-ph__muted">Finding partners…</div>
  if (matches.length === 0) {
    return (
      <div className="v2-hcard v2-ph__panel v2-ph__panel--neutral">
        <div className="v2-ph__paneltitle">No matches yet</div>
        <p className="v2-ph__muted">
          Nobody who fits what you asked for — and who'd want to train with you — has unlocked Partner Hunt yet.
          Widening your activities, times or age range brings in more people.
        </p>
      </div>
    )
  }
  return (
    <div className="v2-ph__grid">
      {matches.map((m) => <MatchCard key={m.user_id} match={m} onBlock={onBlock} />)}
    </div>
  )
}

export function MatchCard({ match, onBlock }: { match: PartnerMatch; onBlock: (match: PartnerMatch) => void }) {
  const [confirming, setConfirming] = useState(false)
  const meet = match.meet.includes('in_person')
    ? `Can meet in ${match.city ?? 'your city'}${match.meet.includes('remote') ? ' or train remotely' : ''}`
    : 'Remote training'
  return (
    <article className="v2-hcard v2-ph__card" aria-label={match.display_name}>
      <div className="v2-ph__cardtop">
        <div>
          <div className="v2-ph__name">{match.display_name}</div>
          <div className="v2-ph__muted">{match.age_band} · {cap(match.fitness_level)}</div>
        </div>
        <span className="v2-ph__score" title="How well your preferences line up">{match.score}% match</span>
      </div>
      <ul className="v2-ph__reasons">
        {match.reasons.map((r) => <li key={r}>{r}</li>)}
      </ul>
      <div className="v2-ph__chips">
        {match.shared_activities.map((a) => <span key={a} className="v2-chip">{activityLabel(a)}</span>)}
        {match.shared_times.map((t) => <span key={t} className="v2-chip">{timeLabel(t)}</span>)}
      </div>
      <div className="v2-ph__muted">{meet}</div>
      <div className="v2-ph__cardfoot">
        {confirming ? (
          <div className="v2-ph__confirm" role="alertdialog" aria-label={`Block ${match.display_name}?`}>
            <span>Block {match.display_name}? Neither of you will see the other again.</span>
            <button className="v2-btn v2-btn--ghost v2-btn--sm" onClick={() => setConfirming(false)}>Cancel</button>
            <button className="v2-btn v2-btn--sm v2-ph__danger" onClick={() => { setConfirming(false); onBlock(match) }}>Block</button>
          </div>
        ) : (
          <>
            <span className="v2-pill v2-pill--soon" title="Connecting with a match comes next">Connect · Soon</span>
            <button className="v2-ph__linkbtn" onClick={() => setConfirming(true)}>
              {Icon.x({ size: 13 })} Block
            </button>
          </>
        )}
      </div>
    </article>
  )
}
