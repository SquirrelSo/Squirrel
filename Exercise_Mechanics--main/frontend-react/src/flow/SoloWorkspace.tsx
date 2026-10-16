/* SoloWorkspace.tsx — the Solo home reached from the Solo tile. Sidebar (Exercise
   Library / Analytics & Insights) + a two-pane builder:

     • Left  — browse categories (single-open accordion) and ADD exercises to the
               workout (cart-style).
     • Right — "Your Workout": a session-level SKILL LEVEL on top, then each added
               exercise with its own SETS × REPS steppers and a remove control, and
               Start Training at the bottom.

   Only Squat is implemented today, so only it can be added; the rest show "Soon".
   Start Training launches the coach (camera auto-opens, saved baseline reused).

   Analytics & Insights: a "report coming soon" view (no session data yet). */
import { useEffect, useMemo, useState, type ReactNode, type CSSProperties } from 'react'
import { Ico, Icon } from '../tokens'
import { fetchExerciseCatalog, fetchSkill, loadCachedSkill, saveSession, type SessionExercise, type SkillLevel } from './storage'
import { AnalyticsInsights } from './report/SessionReport'
import { PillButton, Wordmark } from './uiV2'
import type { WorkoutConfig } from '../types'

type Measure = 'reps' | 'time' // rep-counted vs. timed hold/interval (e.g. Plank)
type Variant = 'single' | 'double'
// `key` is the cart identity (unique per catalog entry, so single/double coexist). `slug` is
// the canonical backend exercise (variant-independent) that drives the YAML/engine; `variant`
// (curl only) picks the arm(s). slug defaults to key when omitted (squat).
type Exercise = { key: string; slug?: string; variant?: Variant; name: string; type: string; measure: Measure; live: boolean; image?: string }
type Category = { key: string; name: string; short: string; icon: ReactNode; exercises: Exercise[] }
// `value` is reps for measure==='reps', or seconds for measure==='time'. bodyPart +
// tag are carried so the saved session_info.json has the full per-exercise detail.
type CartItem = { key: string; slug?: string; variant?: Variant; name: string; bodyPart: string; tag: string; measure: Measure; sets: number; value: number; restSeconds: number }

const CATALOG: Category[] = [
  {
    key: 'upper',
    name: 'Upper Body',
    short: 'Upper Body',
    // head + torso + spread arms, no legs — reads as the upper body
    icon: <Ico size={22} paths={<><circle cx="12" cy="5" r="2.2" /><path d="M12 7.2V15" /><path d="M5.5 10.5 12 12.5 18.5 10.5" /></>} />,
    exercises: [
      { key: 'bicep_curl_single', slug: 'bicep_curl', variant: 'single', name: 'Single Arm Bicep Curl', type: 'Strength', measure: 'reps', live: false, image: '/ex-bicep-curl-single.jpg' },
      { key: 'bicep_curl_double', slug: 'bicep_curl', variant: 'double', name: 'Double Arm Bicep Curl', type: 'Strength', measure: 'reps', live: false, image: '/ex-bicep-curl-double.jpg' },
      // Push-up is coached from the SIDE, unlike every other card here — the backend catalog
      // carries that (view: side) and the setup flow refuses a front-on camera, so nothing extra
      // is needed on this side beyond offering the exercise.
      { key: 'pushup', name: 'Push-up', type: 'Strength', measure: 'reps', live: true },
    ],
  },
  {
    key: 'lower',
    name: 'Lower Body',
    short: 'Lower Body',
    // hip line + two legs, no head/torso — reads as the lower body
    icon: <Ico size={22} paths={<><path d="M7.5 5H16.5" /><path d="M9.5 5 7.5 20" /><path d="M14.5 5 16.5 20" /></>} />,
    exercises: [
      { key: 'squat', name: 'Squat', type: 'Strength', measure: 'reps', live: true, image: '/ex-squat.jpg' },
      { key: 'lunges', name: 'Lunges', type: 'Strength', measure: 'reps', live: false, image: '/ex-lunges.jpg' },
    ],
  },
  {
    key: 'full',
    name: 'Full Body · Cardio · Core',
    short: 'Core & Cardio',
    // full stick figure — head, torso, arms and legs
    icon: <Ico size={22} paths={<><circle cx="12" cy="4" r="2" /><path d="M12 6V13" /><path d="M6.5 9 12 10.5 17.5 9" /><path d="M12 13 8.5 20" /><path d="M12 13 15.5 20" /></>} />,
    exercises: [
      { key: 'plank', name: 'Plank', type: 'Core', measure: 'time', live: false, image: '/ex-plank.jpg' },
      { key: 'high_knee', name: 'High Knees', type: 'HIIT', measure: 'time', live: false, image: '/ex-high-knees.jpg' },
    ],
  },
]

// Sensible defaults + bounds per measure when an exercise is added to the workout.
const DEFAULTS = {
  reps: { value: 12, min: 1, max: 50, step: 1 },
  time: { value: 30, min: 5, max: 300, step: 5 },
} as const

// Rest interval (between sets) defaults + bounds. Only meaningful when sets > 1.
const REST = { value: 60, min: 0, max: 300, step: 15 } as const

// Body-part filter for Free Session: "All" + each catalog category (short label).
const FILTERS = ['All', ...CATALOG.map((c) => c.short)]
// Skill level → filled difficulty dots. Level is the USER's skill (from skill.json / cache),
// shown the same on every card — not a per-exercise difficulty (there is no such source).
const SKILL_DOTS: Record<SkillLevel, number> = { beginner: 1, intermediate: 2, advanced: 3 }
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
// Card display name drops any parenthetical (variant shown as its own chip): "Bicep Curl (Single Arm)" → "Bicep Curl".
const displayName = (name: string) => name.replace(/\s*\(.*\)\s*/, '').trim()

/* ── Training programs ─────────────────────────────────────────────────────────
   A program is a SESSION STRUCTURE, not a tag on an exercise. The same squat is a
   different workout under each: straight sets vs. a circuit round vs. a timed interval.
   The user picks a goal FIRST; the builder + cart then adapt to that structure.

   `mode` drives the cart shape:
     sets      — per-exercise Sets × Reps + rest between sets (classic strength).
     rounds    — the whole list is one round; global Rounds + rest between rounds; order matters.
     intervals — global Work / Rest / Rounds; every exercise performed for the work interval.
     free      — no structure; browse everything and add whatever (today's behaviour).
   `recommended` is the ideal ORDER (exercise keys; may include not-yet-live ones — shown as
   "soon" placeholders so the structure is right from day one). `discouraged` = exercises that
   don't fit this goal (e.g. High Knees under Strength); they're hidden from the program's list. */
type ProgramId = 'strength' | 'circuit' | 'hiit' | 'free'
type StructureMode = 'sets' | 'rounds' | 'intervals' | 'free'
type Program = {
  id: ProgramId
  name: string
  tag: string            // "best for" one-liner
  blurb: string          // how the session is structured
  mode: StructureMode
  color: string
  icon: ReactNode
  recommended: string[]  // exercise keys, ideal order
  discouraged: Record<string, string>  // key → why it's a poor fit for this goal
}

const PROGRAMS: Program[] = [
  {
    id: 'strength', name: 'Strength', tag: 'Build muscle & lifting performance',
    blurb: 'Straight sets with full recovery — finish every set of one exercise before the next.',
    mode: 'sets', color: '#8C7BFF',
    icon: <Ico size={26} paths={<><path d="M6.5 6.5v11M3.5 9v6M17.5 6.5v11M20.5 9v6M6.5 12h11" /></>} />,
    recommended: ['squat', 'lunges', 'pushup', 'bicep_curl_single', 'plank'],
    discouraged: { high_knee: 'Skip for strength — save your energy for the lifts.' },
  },
  {
    id: 'circuit', name: 'Full-Body Conditioning', tag: 'General fitness, fat loss, time-efficient',
    blurb: 'Circuit — move through every exercise back-to-back, rest, then repeat for a few rounds.',
    mode: 'rounds', color: '#2DD4BF',
    icon: <Ico size={26} paths={<><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></>} />,
    recommended: ['squat', 'bicep_curl_single', 'pushup', 'lunges', 'high_knee', 'plank'],
    discouraged: {},
  },
  {
    id: 'hiit', name: 'HIIT', tag: 'Cardio endurance & max calorie burn',
    blurb: 'Timed intervals at max effort — work hard, short rest, repeat the circuit.',
    mode: 'intervals', color: '#FF6B6B',
    icon: <Ico size={26} d="M13 2 4 14h6l-1 8 9-12h-6z" fill="currentColor" stroke="none" />,
    recommended: ['high_knee', 'squat', 'lunges'],
    discouraged: {
      plank: 'Static hold — HIIT wants explosive, max-effort movement.',
      bicep_curl_single: 'Isolation lift — too little to sustain a max-effort interval.',
      bicep_curl_double: 'Isolation lift — too little to sustain a max-effort interval.',
    },
  },
  {
    id: 'free', name: 'Free Session', tag: 'Build your own mix, your way',
    blurb: 'No fixed structure — browse the whole library and add whatever you feel like today.',
    mode: 'free', color: '#56C2FF',
    icon: <Ico size={26} paths={<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><path d="M17.5 14.5v6M14.5 17.5h6" /></>} />,
    recommended: [], discouraged: {},
  },
]
const PROGRAM_BY_ID: Record<ProgramId, Program> = Object.fromEntries(PROGRAMS.map((p) => [p.id, p])) as Record<ProgramId, Program>

// Flat {exercise, bodyPart} list + a key→entry index, for program grouping + the recommended fill.
const ALL_EX: { ex: Exercise; bodyPart: string }[] = CATALOG.flatMap((c) => c.exercises.map((ex) => ({ ex, bodyPart: c.name })))
const EX_INDEX: Record<string, { ex: Exercise; bodyPart: string }> = Object.fromEntries(ALL_EX.map((e) => [e.ex.key, e]))
// Category full-name → short label, for the body-part chip shown on structured-program cards.
const BODYPART_SHORT: Record<string, string> = Object.fromEntries(CATALOG.map((c) => [c.name, c.short]))

export function SoloWorkspace(
  { userId, onStartTraining, onExit }:
  { userId: string; onStartTraining: (sessionId: string, workout: WorkoutConfig) => void; onExit: () => void },
) {
  const [tab, setTab] = useState<'library' | 'analytics'>('library')

  return (
    <div className="v2 v2-hub">
      <header className="v2-htop">
        <div className="v2-htop__brand"><Wordmark size={14} /></div>
        <nav className="v2-htop__nav">
          <button className={`v2-hnavitem${tab === 'library' ? ' v2-hnavitem--active' : ''}`} onClick={() => setTab('library')}>
            {Icon.dumbbell({ size: 18 })} Exercise Library
          </button>
          <button className={`v2-hnavitem${tab === 'analytics' ? ' v2-hnavitem--active' : ''}`} onClick={() => setTab('analytics')}>
            <Ico size={18} paths={<><path d="M4 20V10" /><path d="M10 20V4" /><path d="M16 20v-7" /><path d="M21 20H3" /></>} /> Analytics &amp; Insights
          </button>
        </nav>
        <div className="v2-htop__foot">
          <button className="v2-hbackbtn" onClick={onExit}>
            <Ico size={16} d="M15 18l-6-6 6-6" /> Home
          </button>
        </div>
      </header>

      <main className="v2-hmain">
        {tab === 'library' ? (
          <ExerciseBuilder userId={userId} onStartTraining={onStartTraining} />
        ) : (
          <AnalyticsInsights userId={userId} />
        )}
      </main>
    </div>
  )
}

function ExerciseBuilder(
  { userId, onStartTraining }: { userId: string; onStartTraining: (sessionId: string, workout: WorkoutConfig) => void },
) {
  const [program, setProgram] = useState<ProgramId | null>(null)  // null = the goal-selection landing
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<string>('All')   // Free Session only
  const [cart, setCart] = useState<CartItem[]>([])
  // Global structure config: rounds + rest-between-rounds (circuit); work/rest/rounds (HIIT).
  const [cfg, setCfg] = useState({ rounds: 3, roundRest: 60, work: 40, rest: 20 })
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [availability, setAvailability] = useState<Record<string, 'enabled' | 'planned'>>({})
  // The user's skill level (set on the Home Skill card, stored in skill.json). Seed from the
  // web cache for an instant value, then refresh from the drive file.
  const [skill, setSkill] = useState<SkillLevel>(() => loadCachedSkill(userId) ?? 'beginner')
  useEffect(() => {
    let cancelled = false
    fetchSkill(userId).then((s) => { if (!cancelled) setSkill(s) }).catch(() => { /* keep cached/default */ })
    return () => { cancelled = true }
  }, [userId])
  useEffect(() => {
    let cancelled = false
    fetchExerciseCatalog()
      .then((entries) => {
        if (!cancelled) setAvailability(Object.fromEntries(entries.map((entry) => [entry.id, entry.status])))
      })
      .catch(() => { /* backend still rejects any stale planned entry at session creation */ })
    return () => { cancelled = true }
  }, [])

  const isLive = (ex: Exercise) => (availability[ex.slug ?? ex.key] ?? (ex.live ? 'enabled' : 'planned')) === 'enabled'

  const inCart = (key: string) => cart.some((i) => i.key === key)
  const toCartItem = (ex: Exercise, bodyPart: string): CartItem => (
    { key: ex.key, slug: ex.slug, variant: ex.variant, name: ex.name, bodyPart, tag: ex.type, measure: ex.measure, sets: 3, value: DEFAULTS[ex.measure].value, restSeconds: REST.value }
  )
  const add = (ex: Exercise, bodyPart: string) => setCart((c) => (
    c.some((i) => i.key === ex.key) ? c : [...c, toCartItem(ex, bodyPart)]
  ))
  // Batch add: append every given exercise not already in the cart, in one update
  // (a functional setState so we never add on a stale `cart` snapshot).
  const addMany = (items: { ex: Exercise; bodyPart: string }[]) => setCart((c) => {
    const have = new Set(c.map((i) => i.key))
    const additions = items.filter(({ ex }) => !have.has(ex.key)).map(({ ex, bodyPart }) => toCartItem(ex, bodyPart))
    return additions.length ? [...c, ...additions] : c
  })
  const remove = (key: string) => setCart((c) => c.filter((i) => i.key !== key))
  const patch = (key: string, p: Partial<CartItem>) => setCart((c) => c.map((i) => (i.key === key ? { ...i, ...p } : i)))
  // Reorder (circuit / HIIT — order is the workout structure): swap an item with its neighbour.
  const move = (idx: number, dir: -1 | 1) => setCart((c) => {
    const j = idx + dir
    if (j < 0 || j >= c.length) return c
    const next = c.slice()
    ;[next[idx], next[j]] = [next[j], next[idx]]
    return next
  })

  const prog = program ? PROGRAM_BY_ID[program] : null
  // Pick a goal → reset the plan + structure config to that program's defaults.
  const pickProgram = (id: ProgramId) => {
    setProgram(id); setCart([]); setSearch(''); setFilter('All')
    setCfg(id === 'hiit' ? { rounds: 4, roundRest: 60, work: 40, rest: 20 } : { rounds: 3, roundRest: 60, work: 40, rest: 20 })
  }
  const changeGoal = () => { setProgram(null); setCart([]); setSearch(''); setFilter('All') }

  // Map a cart item to the backend SessionExercise per the active structure. The schema is
  // unchanged — circuit rounds → sets + rest-between-rounds; HIIT → time-boxed sets; order kept
  // by the cart array. Best-effort into the existing contract, no backend change.
  const mapItem = (i: CartItem): SessionExercise => {
    const base = { name: i.name, slug: i.slug ?? i.key, variant: i.variant, body_part: i.bodyPart, training_tag: i.tag }
    if (prog?.mode === 'rounds')    return { ...base, measure: i.measure, sets: cfg.rounds, value: i.value, rest_seconds: cfg.roundRest }
    if (prog?.mode === 'intervals') return { ...base, measure: 'time', sets: cfg.rounds, value: cfg.work, rest_seconds: cfg.rest }
    return { ...base, measure: i.measure, sets: i.sets, value: i.value, rest_seconds: i.restSeconds }
  }

  // Exercises visible under the current filter + search, grouped by catalog section.
  // Shared by the grid render and the "Add all" action so they can never disagree.
  const sections = useMemo(() => {
    const q = search.trim().toLowerCase()
    return CATALOG
      .filter((cat) => filter === 'All' || cat.short === filter)
      .map((cat) => ({
        cat,
        shown: cat.exercises.filter((e) => !q || e.name.toLowerCase().includes(q)),
      }))
      .filter((s) => s.shown.length > 0)
  }, [search, filter])

  // Every live, not-yet-added exercise in the current view (with its body-part), for "Add all".
  const addableShown = sections.flatMap(({ cat, shown }) =>
    shown.filter((e) => isLive(e) && !inCart(e.key)).map((ex) => ({ ex, bodyPart: cat.name })))

  // On Start: persist the session (the backend stamps the saved skill level) and enter the
  // coach. The per-set pre-check captures the baseline the coach needs — no calibration gate.
  async function start() {
    if (starting) return
    if (cart.length !== 1) {
      setStartError('Prototype 1 currently starts one enabled exercise at a time.')
      return
    }
    setStarting(true)
    setStartError(null)
    const exercises: SessionExercise[] = cart.map(mapItem)
    try {
      const created = await saveSession(userId, exercises)
      // The persisted normalized plan is authoritative for setup and training.
      const workout: WorkoutConfig = {
        exerciseId: created.exercise_id,
        exerciseName: created.exercise_name,
        variant: created.variant ?? undefined,
        sets: created.sets,
        measure: created.target.type,
        reps: created.target.type === 'reps' ? created.target.value : 0,
        durationSeconds: created.target.type === 'time' ? created.target.value_ms / 1000 : 0,
        restSeconds: created.rest_seconds,
      }
      onStartTraining(created.session_id, workout)
    } catch (error) {
      setStartError(error instanceof Error ? error.message : 'Could not create the session. Please retry.')
      setStarting(false)
    }
  }

  // Goal-selection landing — the user picks HOW they want to train before building.
  if (program === null || prog === null) return <GoalSelection onPick={pickProgram} />

  // Grid data. Non-free programs group "Recommended (ideal order)" + "Also available"; free
  // keeps the catalog sections + filter chips + Add-all.
  const q = search.trim().toLowerCase()
  const matches = (ex: Exercise) => !q || ex.name.toLowerCase().includes(q)
  const recoAll = prog.recommended.map((k) => EX_INDEX[k]).filter(Boolean)
  const recoShown = recoAll.filter(({ ex }) => matches(ex))
  const recoLive = recoAll.filter(({ ex }) => isLive(ex))
  // "Also available" = catalog exercises that fit the goal but aren't in the ideal plan.
  // `discouraged` exercises don't belong in this program (e.g. High Knees in Strength) → hidden.
  const otherShown = ALL_EX.filter(({ ex }) => !prog.recommended.includes(ex.key) && !prog.discouraged[ex.key] && matches(ex))
  const applyRecommended = () => setCart(recoLive.map(({ ex, bodyPart }) => toCartItem(ex, bodyPart)))
  const ordered = prog.mode === 'rounds' || prog.mode === 'intervals'
  const structLine =
    prog.mode === 'rounds'      ? `Circuit · ${cfg.rounds} rounds · ${cfg.roundRest}s between`
    : prog.mode === 'intervals' ? `${cfg.work}s work / ${cfg.rest}s rest · ${cfg.rounds} rounds`
    : prog.mode === 'sets'      ? 'Straight sets · full recovery'
    : `${cart.length} exercise${cart.length === 1 ? '' : 's'}`
  // Every card shows its body-part category on the chip (structured programs and Free Session alike).
  const card = (ex: Exercise, bodyPart: string, note?: string) => (
    <ExCard key={ex.key} ex={ex} live={isLive(ex)} skill={skill} added={inCart(ex.key)} note={note}
      bodyPart={bodyPart}
      onAdd={() => add(ex, bodyPart)} />
  )

  return (
    <div className="v2-lib">
      {/* ── Browse / add ── */}
      <section className="v2-lib__browse">
        {/* Chosen program + structure, with a way back to the goal picker. */}
        <div className="v2-progbar">
          <span className="v2-progbar__icon" style={{ color: prog.color, background: `${prog.color}22`, borderColor: `${prog.color}55` }}>{prog.icon}</span>
          <div className="v2-progbar__info">
            <div className="v2-progbar__name">{prog.name}</div>
            <div className="v2-progbar__blurb">{prog.blurb}</div>
          </div>
          <button className="v2-progbar__change" onClick={changeGoal}><Ico size={15} d="M15 18l-6-6 6-6" /> Change goal</button>
        </div>

        {/* One-click ideal plan (structured programs only). Numbered = ideal order; non-live
            exercises show as "soon" placeholders so the structure is right from day one. */}
        {prog.mode !== 'free' && recoLive.length > 0 && (
          <div className="v2-reco">
            <div className="v2-reco__head">
              <div>
                <div className="v2-reco__title">Recommended plan</div>
                <div className="v2-reco__sub">A ready-made {prog.name} session, in the ideal order.</div>
              </div>
              <button className="v2-reco__use" onClick={applyRecommended}><Ico size={15} d="M20 6 9 17l-5-5" /> Use this plan</button>
            </div>
            <ol className="v2-reco__list">
              {recoAll.map(({ ex, bodyPart }, i) => (
                <li key={ex.key} className={`v2-reco__item${isLive(ex) ? '' : ' v2-reco__item--soon'}`}>
                  <span className="v2-reco__num">{i + 1}</span>
                  <span className="v2-reco__name">{displayName(ex.name)}</span>
                  <span className="v2-typechip">{BODYPART_SHORT[bodyPart] ?? bodyPart}</span>
                  {!isLive(ex) && <span className="v2-reco__soontag">soon</span>}
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* Filters + Add-all are Free-Session only; search is always available. */}
        <div className="v2-libctl">
          {prog.mode === 'free' && (
            <div className="v2-lib__filters">
              {FILTERS.map((f) => (
                <button key={f} type="button" className={`v2-libchip${filter === f ? ' v2-libchip--active' : ''}`} onClick={() => setFilter(f)}>{f}</button>
              ))}
              {filter !== 'All' && addableShown.length > 0 && (
                <button type="button" className="v2-libchip v2-libchip--addall" onClick={() => addMany(addableShown)}>
                  <Ico size={14} d="M12 5v14M5 12h14" /> Add all {filter} ({addableShown.length})
                </button>
              )}
            </div>
          )}
          <label className="v2-libsearch">
            <Ico size={17} paths={<><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></>} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search exercises…" />
          </label>
        </div>

        {prog.mode === 'free' ? (
          sections.length === 0
            ? <div className="v2-libempty">No exercises match your search.</div>
            : sections.map(({ cat, shown }) => (
                <section className="v2-libsec" key={cat.key}>
                  <div className="v2-libsec__h">{cat.short} <span>· {shown.length}</span></div>
                  <div className="v2-libgrid">{shown.map((ex) => card(ex, cat.name))}</div>
                </section>
              ))
        ) : (
          <>
            <section className="v2-libsec">
              <div className="v2-libsec__h">Recommended for {prog.name} <span>· {recoShown.length}</span></div>
              {recoShown.length === 0
                ? <div className="v2-libempty">No matches for your search.</div>
                : <div className="v2-libgrid">{recoShown.map(({ ex, bodyPart }) => card(ex, bodyPart))}</div>}
            </section>
            {otherShown.length > 0 && (
              <section className="v2-libsec">
                <div className="v2-libsec__h">Also available <span>· {otherShown.length}</span></div>
                <div className="v2-libgrid">{otherShown.map(({ ex, bodyPart }) => card(ex, bodyPart))}</div>
              </section>
            )}
          </>
        )}
      </section>

      {/* ── Your plan (cart) — its fields change with the program's structure ── */}
      <aside className="v2-cart">
        <div className="v2-cart__head">
          <span className="v2-hcard__label">Your Plan</span>
          <span className="v2-cart__struct">{structLine}</span>
        </div>

        {/* Global structure config for circuit (rounds) / HIIT (work·rest·rounds). */}
        {prog.mode === 'rounds' && (
          <div className="v2-cartcfg">
            <div className="v2-cartcfg__field"><span className="v2-fieldlabel">Rounds</span><Stepper value={cfg.rounds} min={2} max={6} onChange={(v) => setCfg((c) => ({ ...c, rounds: v }))} /></div>
            <div className="v2-cartcfg__field"><span className="v2-fieldlabel">Rest / round</span><Stepper value={cfg.roundRest} min={0} max={300} step={15} format={(v) => `${v}s`} onChange={(v) => setCfg((c) => ({ ...c, roundRest: v }))} /></div>
          </div>
        )}
        {prog.mode === 'intervals' && (
          <div className="v2-cartcfg v2-cartcfg--3">
            <div className="v2-cartcfg__field"><span className="v2-fieldlabel">Work</span><Stepper value={cfg.work} min={10} max={120} step={5} format={(v) => `${v}s`} onChange={(v) => setCfg((c) => ({ ...c, work: v }))} /></div>
            <div className="v2-cartcfg__field"><span className="v2-fieldlabel">Rest</span><Stepper value={cfg.rest} min={5} max={60} step={5} format={(v) => `${v}s`} onChange={(v) => setCfg((c) => ({ ...c, rest: v }))} /></div>
            <div className="v2-cartcfg__field"><span className="v2-fieldlabel">Rounds</span><Stepper value={cfg.rounds} min={2} max={8} onChange={(v) => setCfg((c) => ({ ...c, rounds: v }))} /></div>
          </div>
        )}

        <div className="v2-cart__list">
          {cart.length === 0 ? (
            <div className="v2-cart__empty">No exercises yet.<br />{prog.mode === 'free' ? 'Add any exercises you like.' : 'Add exercises, or use the recommended plan above.'}</div>
          ) : (
            cart.map((item, idx) => (
              <div className="v2-cartitem" key={item.key}>
                <div className="v2-cartitem__top">
                  {ordered && <span className="v2-cartitem__ord">{idx + 1}</span>}
                  <span className="v2-cartitem__name">{item.name}</span>
                  <div className="v2-cartitem__tools">
                    {ordered && (
                      <>
                        <button className="v2-cartitem__mv" disabled={idx === 0} onClick={() => move(idx, -1)} aria-label="Move up"><Ico size={15} d="M18 15l-6-6-6 6" /></button>
                        <button className="v2-cartitem__mv" disabled={idx === cart.length - 1} onClick={() => move(idx, 1)} aria-label="Move down"><Ico size={15} d="M6 9l6 6 6-6" /></button>
                      </>
                    )}
                    <button className="v2-cartitem__rm" onClick={() => remove(item.key)} aria-label={`Remove ${item.name}`}><Ico size={16} paths={<><path d="M18 6 6 18" /><path d="M6 6l12 12" /></>} /></button>
                  </div>
                </div>
                {(prog.mode === 'sets' || prog.mode === 'free') && (
                  <div className="v2-cartitem__cfg">
                    <div className="v2-cartitem__field"><span className="v2-fieldlabel">Sets</span><Stepper value={item.sets} min={1} max={10} onChange={(v) => patch(item.key, { sets: v })} /></div>
                    <div className="v2-cartitem__field"><span className="v2-fieldlabel">{item.measure === 'time' ? 'Duration' : 'Reps'}</span><Stepper value={item.value} min={DEFAULTS[item.measure].min} max={DEFAULTS[item.measure].max} step={DEFAULTS[item.measure].step} format={item.measure === 'time' ? (v) => `${v}s` : undefined} onChange={(v) => patch(item.key, { value: v })} /></div>
                    {item.sets > 1 && (
                      <div className="v2-cartitem__field"><span className="v2-fieldlabel">Set interval</span><Stepper value={item.restSeconds} min={REST.min} max={REST.max} step={REST.step} format={(v) => `${v}s`} onChange={(v) => patch(item.key, { restSeconds: v })} /></div>
                    )}
                  </div>
                )}
                {prog.mode === 'rounds' && (
                  <div className="v2-cartitem__cfg">
                    <div className="v2-cartitem__field"><span className="v2-fieldlabel">{item.measure === 'time' ? 'Hold' : 'Reps'} / round</span><Stepper value={item.value} min={DEFAULTS[item.measure].min} max={DEFAULTS[item.measure].max} step={DEFAULTS[item.measure].step} format={item.measure === 'time' ? (v) => `${v}s` : undefined} onChange={(v) => patch(item.key, { value: v })} /></div>
                  </div>
                )}
                {prog.mode === 'intervals' && (
                  <div className="v2-cartitem__interval">{cfg.work}s max effort · {cfg.rest}s rest</div>
                )}
              </div>
            ))
          )}
        </div>

        <div className="v2-cart__foot">
          {startError && (
            <div className="v2-cart__error" role="alert">
              <b>Session not started.</b> {startError}
            </div>
          )}
          <PillButton onClick={start} disabled={cart.length === 0 || starting} style={{ width: '100%' }}>
            {starting ? 'Creating session…' : startError ? 'Retry Start →' : 'Start Training →'}
          </PillButton>
        </div>
      </aside>
    </div>
  )
}

/* The goal-first landing: choose a training program before building the session. */
function GoalSelection({ onPick }: { onPick: (id: ProgramId) => void }) {
  return (
    <div className="v2-goals">
      <div className="v2-goals__main">
        <div className="v2-hhead">
          <h1 className="v2-htitle">What&apos;s your goal today?</h1>
          <p className="v2-hsub">Each program structures the session differently — pick how you want to train and we&apos;ll suggest a plan.</p>
        </div>
        <div className="v2-goalstack">
          {PROGRAMS.map((p) => (
            <button key={p.id} type="button" className="v2-goalcard" style={{ ['--gc']: p.color } as CSSProperties} onClick={() => onPick(p.id)}>
              <span className="v2-goalcard__icon">{p.icon}</span>
              <div className="v2-goalcard__body">
                <div className="v2-goalcard__name">{p.name}</div>
                <div className="v2-goalcard__tag">{p.tag}</div>
                <div className="v2-goalcard__blurb">{p.blurb}</div>
              </div>
              <span className="v2-goalcard__arrow"><Ico size={20} d="M9 6l6 6-6 6" /></span>
            </button>
          ))}
        </div>
      </div>
      {/* Concept image (self-hosted, swappable at public/programs-panel.jpg) + scrim + copy —
          same photo-panel pattern ModeSelect uses. */}
      <aside className="v2-goalpanel">
        <div className="v2-goalpanel__photo" aria-hidden />
        <div className="v2-goalpanel__scrim" aria-hidden />
        <p className="v2-goalpanel__eyebrow">Train with intent</p>
        <h2 className="v2-goalpanel__title">Pick the way you want to move today.</h2>
        <p className="v2-goalpanel__desc">Strength, conditioning, or all-out intervals — each program shapes your session and coaches your form, rep by rep.</p>
      </aside>
    </div>
  )
}

/* One exercise card — shared by the Free catalog grid and the program-grouped grids.
   `note` (optional) surfaces a "poor fit for this goal" hint instead of hiding the card. */
function ExCard(
  { ex, live, skill, added, note, bodyPart, onAdd }:
  { ex: Exercise; live: boolean; skill: SkillLevel; added: boolean; note?: string; bodyPart: string; onAdd: () => void },
) {
  const dots = SKILL_DOTS[skill]
  // Full-bleed photo card: name + body-part chip + skill + action overlaid on the image (self-hosted
  // at `ex.image`; a missing file falls back to the card's brand gradient).
  return (
    <div className={`v2-excard${live ? '' : ' v2-excard--soon'}`}>
      <div className="v2-excard__img" style={ex.image ? { backgroundImage: `url("${ex.image}")` } : undefined} />
      <div className="v2-excard__scrim" />
      <span className="v2-exskill">
        {cap(skill)}
        <span className="v2-exskill__dots">
          {[0, 1, 2].map((i) => <span key={i} className={`v2-exskill__dot${i < dots ? ' v2-exskill__dot--on' : ''}`} />)}
        </span>
      </span>
      <div className="v2-excard__body">
        <div className="v2-excard__meta"><span className="v2-typechip">{BODYPART_SHORT[bodyPart] ?? bodyPart}</span></div>
        <div className="v2-excard__name">{displayName(ex.name)}</div>
        {note && <div className="v2-excard__note">{note}</div>}
        {!live
          ? <div className="v2-excard__soon">Coming soon</div>
          : added
            ? <div className="v2-excard__added"><Ico size={15} d="M20 6 9 17l-5-5" /> Added</div>
            : <button className="v2-excard__add" onClick={onAdd}><Ico size={15} d="M12 5v14M5 12h14" /> Add to workout</button>}
      </div>
    </div>
  )
}

/* Numeric stepper (sets / reps / duration). `step` sizes each increment; `format`
   renders the value (e.g. seconds → "30s"). */
function Stepper(
  { value, min, max, step = 1, format, onChange }:
  { value: number; min: number; max: number; step?: number; format?: (v: number) => string; onChange: (v: number) => void },
) {
  return (
    <div className="v2-step">
      <button type="button" className="v2-step__btn" onClick={() => onChange(Math.max(min, value - step))} disabled={value <= min} aria-label="Decrease">−</button>
      <span className="v2-step__val">{format ? format(value) : value}</span>
      <button type="button" className="v2-step__btn" onClick={() => onChange(Math.min(max, value + step))} disabled={value >= max} aria-label="Increase">+</button>
    </div>
  )
}
