/* ModeSelect.tsx — the session hub reached after calibration (new user) or via
   Continue (returning user), in the V2 flat language: full-viewport (no Stage
   board), a Mobbin-style floating pill top bar (logo · Home · Training ·
   profile) instead of a side rail, monochrome nav — accent color reserved for
   real status (live/available, saved/updated, BMI category). Two views:

     • Home          — Fitness Assessment info, real BMI (from saved height/weight),
                       Today's Schedule (mock), and a live Skill Level toggle.
     • Training Mode — split layout: a pose/keypoint panel on the left, the three
                       ways to train stacked on the right (Solo is live and gets
                       the hero card; Group/1:1 are compact "Soon" rows).
     • Partner Hunt  — find people to train with, behind the Run Module's XP gate
                       (PartnerHunt.tsx).
*/
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Ico, Icon } from '../tokens'
import { fetchActivity, fetchProfile, fetchSkillState, updateSkill, type CachedUser, type UserProfile } from './storage'
import { Wordmark } from './uiV2'
import { PartnerHunt } from './PartnerHunt'

type SkillLevel = 'beginner' | 'intermediate' | 'advanced'

type Mode = {
  key: string
  title: string
  desc: string
  icon: ReactNode
  live: boolean
}

const MODES: Mode[] = [
  {
    key: 'solo',
    title: 'Solo Training',
    desc: 'Train on your own with real-time AI form coaching cueing you on every rep.',
    icon: <Ico size={24} paths={<><circle cx="12" cy="7.4" r="3.4" /><path d="M5 20c0-4 3.2-6.6 7-6.6s7 2.6 7 6.6" /></>} />,
    live: true,
  },
  {
    key: 'group',
    title: 'Group Class',
    desc: 'Join a live class — your coach watches the room while AI tracks each member’s form.',
    icon: <Ico size={24} paths={<><circle cx="9.5" cy="7.5" r="3.5" /><path d="M16.5 20v-1.5a4 4 0 0 0-4-4h-6a4 4 0 0 0-4 4V20" /><path d="M15.5 4.13a3.5 3.5 0 0 1 0 6.75" /><path d="M22 20v-1.5a4 4 0 0 0-3-3.87" /></>} />,
    live: false,
  },
  {
    key: 'one_to_one',
    title: '1:1 Coaching',
    desc: 'A dedicated coach, backed by precise form data from every rep, personalising your training.',
    icon: <Ico size={24} paths={<><circle cx="7.5" cy="7.5" r="3" /><circle cx="16.5" cy="16.5" r="3" /><path d="M9.9 9.9l4.2 4.2" /></>} />,
    live: false,
  },
]

/* the live mode's icon is the one place color is used — everything else stays neutral */
const LIVE_ACCENT = '#FFC93C'
const LIVE_ICON_STYLE: CSSProperties = { color: LIVE_ACCENT, background: `${LIVE_ACCENT}21`, borderColor: `${LIVE_ACCENT}66` }

export function ModeSelect(
  { user, onSelectSolo, onLogout }:
  { user: CachedUser; onSelectSolo: () => void; onLogout: () => void },
) {
  const [view, setView] = useState<'home' | 'training' | 'partners'>('home')

  return (
    <div className="v2 v2-hub">
      <header className="v2-htop">
        <div className="v2-htop__brand"><Wordmark size={14} /></div>
        <nav className="v2-htop__nav">
          <button className={`v2-hnavitem${view === 'home' ? ' v2-hnavitem--active' : ''}`} onClick={() => setView('home')}>
            <Ico size={18} paths={<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /></>} /> Home
          </button>
          <button className={`v2-hnavitem${view === 'training' ? ' v2-hnavitem--active' : ''}`} onClick={() => setView('training')}>
            {Icon.dumbbell({ size: 18 })} Training
          </button>
          <button className={`v2-hnavitem${view === 'partners' ? ' v2-hnavitem--active' : ''}`} onClick={() => setView('partners')}>
            <Ico size={18} paths={<><circle cx="8" cy="8" r="3" /><circle cx="16" cy="8" r="3" /><path d="M2.5 19c0-3.3 2.5-5.5 5.5-5.5s5.5 2.2 5.5 5.5" /><path d="M13.6 14.2c.7-.4 1.5-.7 2.4-.7 3 0 5.5 2.2 5.5 5.5" /></>} /> Partner Hunt
          </button>
        </nav>
        <ProfileMenu user={user} onLogout={onLogout} />
      </header>

      <main className="v2-hmain">
        {view === 'home'
          ? <Home user={user} />
          : view === 'partners'
            ? <PartnerHunt userId={user.user_id} />
            : <TrainingMode onSelectSolo={onSelectSolo} />}
      </main>
    </div>
  )
}

/* ── Profile menu (top bar, right): avatar + name → click reveals Log out ── */
function ProfileMenu({ user, onLogout }: { user: CachedUser; onLogout: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])

  const initials = `${user.first_name?.[0] ?? ''}${user.last_name?.[0] ?? ''}`.toUpperCase()
  const fullName = `${user.first_name} ${user.last_name}`.trim()

  return (
    <div className="v2-htop__foot" ref={ref}>
      {open && (
        <div className="v2-hmenu" role="menu">
          <button className="v2-hmenuitem" role="menuitem" onClick={onLogout}>
            {Icon.power({ size: 16 })} Log out
          </button>
        </div>
      )}
      <button
        className={`v2-hprofilebtn${open ? ' v2-hprofilebtn--open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu" aria-expanded={open} aria-label={fullName}
      >
        <span className="v2-avatar">{initials}</span>
        {Icon.chevU({ size: 15, style: { color: 'var(--v2-mute)', transform: open ? 'none' : 'rotate(180deg)', transition: 'transform .2s' } })}
      </button>
    </div>
  )
}

/* ── Training Mode: keypoint panel + stacked cards (live mode gets the hero card) ── */
function TrainingMode({ onSelectSolo }: { onSelectSolo: () => void }) {
  const liveMode = MODES.find((m) => m.live)!
  const soonModes = MODES.filter((m) => !m.live)

  return (
    <>
      <div className="v2-hhead">
        <h1 className="v2-htitle">Training Mode</h1>
        <p className="v2-hsub">Choose how you want to train today.</p>
      </div>
      <div className="v2-trainwrap">
        <TrainingPanel />
        <div className="v2-traincards">
          <ModeCard mode={liveMode} delay={0} hero onClick={onSelectSolo} />
          {soonModes.map((m, i) => (
            <ModeRow key={m.key} mode={m} delay={(i + 1) * 70} />
          ))}
        </div>
      </div>
    </>
  )
}

/* left panel: pose/keypoint motif, ties Training Mode to the app's real subject matter */
function TrainingPanel() {
  return (
    <div className="v2-trainpanel">
      <div className="v2-trainpanel__photo" aria-hidden />
      <div className="v2-trainpanel__scrim" aria-hidden />
      <p className="v2-trainpanel__eyebrow">Pose-tracked training</p>
      <h2 className="v2-trainpanel__title">Choose your training.</h2>
      <p className="v2-trainpanel__desc">Get real-time feedback on your form, rep by rep. Train solo today — group classes and 1:1 coaching are on the way.</p>
    </div>
  )
}

/* compact row for a not-yet-available mode (Group Class, 1:1 Coaching) */
function ModeRow({ mode, delay }: { mode: Mode; delay: number }) {
  return (
    <div className="v2-modecard v2-modecard--soon v2-modecard--row" style={{ animationDelay: `${delay}ms` }}>
      <span className="v2-modecard__icon">{mode.icon}</span>
      <div className="v2-modecard__body">
        <h4 className="v2-modecard__title">{mode.title}</h4>
        <p className="v2-modecard__desc">{mode.desc}</p>
      </div>
      <span className="v2-pill v2-pill--soon">Soon</span>
    </div>
  )
}

/* ── Home ── */
function Home({ user }: { user: CachedUser }) {
  const [profile, setProfile] = useState<UserProfile | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchProfile(user.user_id).then((p) => { if (!cancelled) setProfile(p) }).catch(() => { /* leave BMI as — */ })
    return () => { cancelled = true }
  }, [user.user_id])

  const h = profile?.height_cm
  const w = profile?.weight_kg

  const now = new Date()
  const dayName = now.toLocaleDateString('en-US', { weekday: 'long' })
  const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  return (
    <>
      <div className="v2-hhead">
        <div className="v2-hgreetdate">{dayName} · {dateStr}</div>
        <h1 className="v2-hwelcome">Good to see you,<br /><span className="v2-greenname">{user.first_name}.</span></h1>
      </div>

      <AssessmentBanner />

      <div className="v2-hgrid2">
        <ScheduleCard />
        <BmiCard profile={profile} />
      </div>

      <div className="v2-hgrid3">
        <SkillCard userId={user.user_id} />
        <MetricCard
          label="Height"
          value={h != null ? String(h) : '—'}
          unit={h != null ? 'cm' : ''}
          note={h != null ? `≈ ${cmToFtIn(h)}` : undefined}
        />
        <MetricCard
          label="Weight"
          value={w != null ? String(w) : '—'}
          unit={w != null ? 'kg' : ''}
          note={w != null ? `≈ ${Math.round(w * 2.20462)} lb` : undefined}
        />
      </div>

      <HeatmapCard userId={user.user_id} />
    </>
  )
}

/* GitHub-style yearly activity grid — one cell per calendar day, lit up on days the user trained. */
function HeatmapCard({ userId }: { userId: string }) {
  const year = new Date().getFullYear()
  const [dates, setDates] = useState<Set<string> | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchActivity(userId, year)
      .then((d) => { if (!cancelled) setDates(new Set(d)) })
      .catch(() => { if (!cancelled) setDates(new Set()) })
    return () => { cancelled = true }
  }, [userId, year])

  const { weeks, months } = useMemo(() => buildYearCalendar(year), [year])
  const count = dates?.size ?? 0
  const cols = weeks.length

  return (
    <div className="v2-hcard v2-heatcard">
      <div className="v2-heatcard__head">
        <span className="v2-hcard__label">Activity — {year}</span>
        <span className="v2-heatcard__count">{dates ? `${count} day${count === 1 ? '' : 's'} trained` : '—'}</span>
      </div>
      <div className="v2-heatgrid">
        {/* day-of-week gutter — a spacer (matching the months row's height) then one label
            per row, so each name lines up with that weekday's row across every week column. */}
        <div className="v2-heatgrid__daylabels">
          <span className="v2-heatgrid__dayspacer" aria-hidden />
          {DAY_LABELS.map((d) => <span key={d} className="v2-heatgrid__daylabel">{d}</span>)}
        </div>
        <div className="v2-heatgrid__inner">
          <div className="v2-heatgrid__months" style={{ gridTemplateColumns: `repeat(${cols}, var(--heat-cell))` }}>
            {months.map((m) => (
              <span key={m.label} className="v2-heatgrid__month" style={{ gridColumnStart: m.colStart }}>{m.label}</span>
            ))}
          </div>
          <div className="v2-heatgrid__weeks">
            {weeks.map((week, wi) => (
              <div key={wi} className="v2-heatgrid__col">
                {week.map((key, di) => (
                  <span
                    key={di}
                    className={`v2-heatcell${key && dates?.has(key) ? ' v2-heatcell--active' : ''}`}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// Row order within each week-column is Sun-start (see buildYearCalendar), so the
// day-of-week gutter must list the same order top-to-bottom.
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function isoLocal(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/* Weeks (Sun-start columns) spanning Jan 1 - Dec 31 of `year`, one column per week (7 cells).
   The first/last week also covers a few days from the adjacent year (the grid is Sunday-aligned)
   — those render as plain empty cells (empty-string key, never active) rather than being hidden,
   so Jan and Dec don't show gaps at the top/bottom of the grid.

   `months` carries one entry per calendar month, each anchored to `colStart`: the 1-based grid
   column of the week in which that month's first day falls. The months row is laid out on a CSS
   grid with the *same* column geometry as the day cells, so each label lines up exactly above the
   column where its month begins — no drift when a label like "Jan" is wider than a cell. */
function buildYearCalendar(year: number): { weeks: string[][]; months: { label: string; colStart: number }[] } {
  const dec31 = new Date(year, 11, 31)
  const cur = new Date(year, 0, 1)
  cur.setDate(cur.getDate() - cur.getDay())

  const weeks: string[][] = []
  const months: { label: string; colStart: number }[] = []
  let lastMonth = -1
  while (cur <= dec31) {
    const week: string[] = []
    for (let d = 0; d < 7; d++) {
      if (cur.getFullYear() === year) {
        week.push(isoLocal(cur))
        if (cur.getMonth() !== lastMonth) {
          lastMonth = cur.getMonth()
          months.push({ label: cur.toLocaleDateString('en-US', { month: 'short' }), colStart: weeks.length + 1 })
        }
      } else {
        week.push('')
      }
      cur.setDate(cur.getDate() + 1)
    }
    weeks.push(week)
  }
  return { weeks, months }
}

function MetricCard({ label, value, unit, note }: { label: string; value: string; unit: string; note?: string }) {
  return (
    <div className="v2-hcard">
      <span className="v2-hcard__label">{label}</span>
      <div className="v2-hmetric" style={value === '—' ? { color: 'var(--v2-faint)' } : undefined}>
        {value}{unit && <span className="v2-hmetric__unit">{unit}</span>}
      </div>
      {note && <div className="v2-hnote">{note}</div>}
    </div>
  )
}

function cmToFtIn(cm: number): string {
  const totalIn = cm / 2.54
  const ft = Math.floor(totalIn / 12)
  const inch = Math.round(totalIn - ft * 12)
  return `${ft}′${inch}″`
}

function BmiCard({ profile }: { profile: UserProfile | null }) {
  const h = profile?.height_cm
  const w = profile?.weight_kg
  const bmi = h && w ? w / ((h / 100) ** 2) : null
  const cat = bmiCategory(bmi)
  const pct = bmi != null ? Math.max(2, Math.min(98, ((bmi - 15) / (40 - 15)) * 100)) : 0

  return (
    <div className="v2-hcard">
      <span className="v2-hcard__label">BMI Index</span>
      {bmi != null ? (
        <>
          <div className="v2-hmetric">{bmi.toFixed(1)}</div>
          <span className="v2-bmicat" style={{ color: cat.color, background: `${cat.color}22` }}>{cat.label}</span>
          <div className="v2-bmibar"><span className="v2-bmimarker" style={{ left: `${pct}%` }} /></div>
          <div className="v2-hnote">Healthy range 18.5–24.9</div>
        </>
      ) : (
        <div className="v2-hmetric" style={{ color: 'var(--v2-faint)' }}>—</div>
      )}
    </div>
  )
}

function bmiCategory(bmi: number | null): { label: string; color: string } {
  if (bmi == null) return { label: '—', color: 'var(--v2-faint)' }
  if (bmi < 18.5) return { label: 'Underweight', color: '#56C2FF' }
  if (bmi < 25) return { label: 'Normal', color: '#3ECF8E' }
  if (bmi < 30) return { label: 'Overweight', color: '#FFB02E' }
  return { label: 'Obese', color: '#E5484D' }
}

const SKILL_DESC: Record<SkillLevel, string> = {
  beginner: 'New to training or easing back in — gentler targets and more on-screen guidance.',
  intermediate: 'Comfortable with the basics — balanced targets and standard form tolerances.',
  advanced: 'Experienced and consistent — higher targets and tighter form standards.',
}

/* Self-contained: loads the saved skill (skill.json) on mount; the Update button
   always persists the current selection server-side (so even the default 'beginner'
   gets written), and shows a brief "Saved ✓" confirmation. */
function SkillCard({ userId }: { userId: string }) {
  // `skill` is the currently-selected segment; `savedSkill` is what's persisted server-side —
  // or null when the user has NOT explicitly set a skill yet (a new profile has no skill.json).
  // We show "Updated" only when the selection matches a persisted level; otherwise (an unsaved
  // new profile, or a changed selection) we show the Update button to persist the choice.
  const [skill, setSkill] = useState<SkillLevel>('beginner')
  const [savedSkill, setSavedSkill] = useState<SkillLevel | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchSkillState(userId)
      .then(({ level, configured }) => {
        if (cancelled) return
        setSkill(level)                                // segment reflects saved level (or the beginner default)
        setSavedSkill(configured ? level : null)       // null until the user actually saves → shows "Update"
      })
      .catch(() => { /* keep default: skill=beginner, savedSkill=null → Update */ })
    return () => { cancelled = true }
  }, [userId])

  const choose = (s: SkillLevel) => setSkill(s)
  async function update() {
    setBusy(true)
    try {
      await updateSkill(userId, skill)
      setSavedSkill(skill)
    } catch { /* ignore */ } finally {
      setBusy(false)
    }
  }

  const isUpdated = savedSkill !== null && skill === savedSkill

  return (
    <div className="v2-hcard">
      <div className="v2-skillhead">
        <span className="v2-hcard__label">Skill Level</span>
        {isUpdated ? (
          <span className="v2-skilldone" role="status">Updated</span>
        ) : (
          <button type="button" className="v2-skillupdate" onClick={update} disabled={busy}>
            {busy ? 'Saving…' : 'Update'}
          </button>
        )}
      </div>
      <div className="v2-seg" role="group">
        {(['beginner', 'intermediate', 'advanced'] as SkillLevel[]).map((s) => (
          <button key={s} type="button" className={`v2-seg__opt${skill === s ? ' v2-seg__opt--active' : ''}`} onClick={() => choose(s)}>
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>
      <p className="v2-skilldesc">{SKILL_DESC[skill]}</p>
    </div>
  )
}

const SCHEDULE = [
  { time: '7:30', name: 'Lower Body Strength', meta: 'Squats · Lunges', dur: '25 min' },
  { time: '13:00', name: 'Core & Mobility', meta: 'Plank · Stretch', dur: '15 min' },
  { time: '18:30', name: 'HIIT Cardio', meta: 'High knees · Burpees', dur: '20 min' },
]

function ScheduleCard() {
  return (
    <div className="v2-hcard">
      <span className="v2-hcard__label">Today’s Schedule</span>
      <div className="v2-schedlist">
        {SCHEDULE.map((s) => (
          <div className="v2-schedrow" key={s.time}>
            <span className="v2-schedtime">{s.time}</span>
            <div>
              <div className="v2-schedname">{s.name}</div>
              <div className="v2-schedmeta">{s.meta}</div>
            </div>
            <span className="v2-scheddur">{s.dur}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* The mandatory first step: a guided movement check that becomes a personal report
   and plan. Compulsory for every member — the "Required" badge + copy make that clear,
   even though enforcement (gating training on it) isn't wired yet. */
function AssessmentBanner() {
  return (
    <div className="v2-assess">
      <div className="v2-assess__body">
        <div className="v2-assess__badges">
          <span className="v2-reqpill"><span className="v2-reqpill__dot" />Required</span>
        </div>
        <h3 className="v2-assess__title">Fitness Assessment</h3>
        <p className="v2-assess__desc">
          A short guided check of how your body moves — how flexible, strong and how much stamina you have.
          We turn it into an easy-to-read report and a training plan made just for you.
        </p>
        <div className="v2-assess__chips">
          <span className="v2-chip">Flexibility</span>
          <span className="v2-chip">Strength</span>
          <span className="v2-chip">Stamina</span>
          <span className="v2-chip">Balance</span>
        </div>
      </div>
      <button type="button" className="v2-assess__cta">
        Take assessment
        <Ico size={17} d="M5 12h14M13 6l6 6-6 6" />
      </button>
    </div>
  )
}

function ModeCard({ mode, delay, onClick, hero }: { mode: Mode; delay: number; onClick?: () => void; hero?: boolean }) {
  const live = !!onClick
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!live}
      className={`v2-modecard ${live ? 'v2-modecard--live' : 'v2-modecard--soon'}${hero ? ' v2-modecard--hero' : ''}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="v2-modecard__top">
        <span className="v2-modecard__icon" style={hero ? LIVE_ICON_STYLE : undefined}>{mode.icon}</span>
        {live
          ? <span className="v2-pill v2-pill--live">Available</span>
          : <span className="v2-pill v2-pill--soon">Soon</span>}
      </div>
      <h3 className="v2-modecard__title">{mode.title}</h3>
      <p className="v2-modecard__desc">{mode.desc}</p>
      <div className="v2-modecard__foot">
        {live
          ? <>Start session <span className="v2-modecard__arrow">→</span></>
          : <span style={{ color: '#FFB02E' }}>Coming soon</span>}
      </div>
    </button>
  )
}
