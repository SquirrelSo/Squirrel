/* App.tsx — top-level flow router. The landing page asks new-vs-existing:

     new visitor:   landing → onboarding → details → modes → (session)
     existing user: landing → returning → modes → (session)
     demo mode:     demo → (session)          ← the default today, see DEMO_PUSHUP below

   The "returning" page combines profile selection (a card per profile cached on this
   device) with the welcome-back greeting; switching profiles never deletes anyone.
   Identity is cached in localStorage (storage.ts). The session branch renders the coach
   (CoachApp brings its own Stage), which owns the camera + WebSocket. The per-set pre-check
   captures the baseline at set start — there is no separate one-time calibration step. */
import { useState } from 'react'
import CoachApp, { type CoachPurpose } from './CoachApp'
import type { WorkoutConfig } from './types'
import CoachStub from './flow/CoachStub'
import { Landing } from './flow/Landing'
import { Onboarding } from './flow/Onboarding'
import { ProfileDetails } from './flow/ProfileDetails'
import { ReturningUser } from './flow/ReturningUser'
import { ModeSelect } from './flow/ModeSelect'
import { SoloWorkspace } from './flow/SoloWorkspace'
import { PushUpDemo } from './flow/PushUpDemo'
import { loadUser, loadUsers, setActiveUser, type CachedUser } from './flow/storage'

// Flip to true to replace the real pose-coach (camera + skeleton + HUD) with a
// camera-free stub, so the flow can be clicked through without the webcam.
// Override per-load with ?coach=real or ?coach=stub.
const USE_COACH_STUB = false

/* Demo-first entry. While this is true the app opens straight on a push-up set — no landing page,
   no profile choice, no workout builder — because that is what a demo needs and clicking through
   four screens to reach the thing being demonstrated is friction, not flow. The full flow is not
   removed, only skipped: open the app with ?demo=off to reach the landing page, and set this to
   false to make the landing page the default again. */
const DEMO_PUSHUP = true

function demoRequested(): boolean {
  const override = new URLSearchParams(location.search).get('demo') // 'pushup' | 'off' | null
  if (override === 'off') return false
  if (override) return true
  return DEMO_PUSHUP
}

type Flow = 'landing' | 'onboarding' | 'details' | 'returning' | 'modes' | 'solo' | 'session' | 'demo'

export default function App() {
  const [user, setUser] = useState<CachedUser | null>(() => loadUser())
  // Demo mode opens on the push-up set; otherwise start on the landing page so the user is asked
  // new-vs-existing.
  const [flow, setFlow] = useState<Flow>(() => (demoRequested() ? 'demo' : 'landing'))
  const [sessionId, setSessionId] = useState<string | undefined>(undefined) // current training session
  const [workout, setWorkout] = useState<WorkoutConfig | undefined>(undefined) // real sets/reps/rest for the session

  // Sign-up page 1 creates the account; page 2 (optional questions) follows before the app proper.
  const onboardingDone = (u: CachedUser) => { setUser(u); setFlow('details') }
  // Switch the active profile from the returning-user dropdown — never deletes anyone.
  const switchTo = (u: CachedUser) => { setActiveUser(u); setUser(u) }
  // Logout: end the session and return to the landing page, but KEEP every cached
  // profile so the user can pick themselves again as an existing user — NOT re-onboarded.
  const logout = () => { setFlow('landing') }

  // The landing page (also the fallback whenever there is no active profile).
  // The V2 entry screens (landing / onboarding / returning) are full-viewport —
  // they do NOT sit inside the scaled 1280x720 Stage board like the rest.
  const landing = (
    <Landing
      onNew={() => setFlow('onboarding')}
      onExisting={() => setFlow('returning')}
      hasProfiles={loadUsers().length > 0}
    />
  )

  switch (flow) {
    case 'demo':
      // Provisions the identity and the session the coach requires, then mounts the real coach on
      // its setup gate. Exiting a demo set returns here for a fresh one.
      return (
        <PushUpDemo
          onReady={(u, sid, w) => { setUser(u); setSessionId(sid); setWorkout(w); setFlow('session') }}
        />
      )

    case 'onboarding':
      return <Onboarding onDone={onboardingDone} onBack={() => setFlow('landing')} />

    case 'details':
      return user ? <ProfileDetails user={user} onDone={() => setFlow('modes')} /> : landing

    case 'returning': {
      const users = loadUsers()
      // No saved profiles → nothing to return to; send them to onboarding.
      if (users.length === 0) return <Onboarding onDone={onboardingDone} onBack={() => setFlow('landing')} />
      return (
        <ReturningUser
          users={users}
          activeId={user?.user_id}
          onSelect={switchTo}
          onContinue={(u) => { switchTo(u); setFlow('modes') }}
          onBack={() => setFlow('landing')}
        />
      )
    }

    case 'modes':
      return user
        ? (
          <ModeSelect
            user={user}
            onSelectSolo={() => setFlow('solo')}
            onLogout={logout}
          />
        )
        : landing

    case 'solo':
      // Full-viewport V2 shell (like ModeSelect) — NOT inside the scaled Stage board.
      return user
        ? (
          <SoloWorkspace
            userId={user.user_id}
            onStartTraining={(sid, w) => { setSessionId(sid); setWorkout(w); setFlow('session') }}
            onExit={() => setFlow('modes')}
          />
        )
        : landing

    case 'session':
      // Session creation is a hard dependency: never mount camera/setup without its persisted id
      // and normalized plan, even if a future flow change reaches this branch incorrectly.
      return user && sessionId && workout
        ? (
          <Coach
            userId={user.user_id}
            purpose="session"
            autoStartCamera
            sessionId={sessionId}
            workout={workout}
            onExit={() => setFlow(demoRequested() ? 'demo' : 'solo')}
          />
        )
        : landing

    case 'landing':
    default:
      // The entry choice (new vs existing user). A logged-out user keeps their
      // cached profile and re-enters via "Existing user".
      return landing
  }
}

/* Keyed so switching purpose (calibrate ⇄ session) fully remounts the coach —
   a fresh engine + WebSocket + calibration, never a stale baseline session.
   Renders the camera-free stub when USE_COACH_STUB (or ?coach=stub) is set. */
function Coach(
  { userId, purpose, onExit, autoStartCamera = false, sessionId, workout }:
  { userId?: string; purpose: CoachPurpose; onExit: () => void; autoStartCamera?: boolean; sessionId?: string; workout?: WorkoutConfig },
) {
  const override = new URLSearchParams(location.search).get('coach') // 'real' | 'stub' | null
  const useStub = override ? override === 'stub' : USE_COACH_STUB
  if (useStub) return <CoachStub key={purpose} userId={userId} purpose={purpose} onExit={onExit} />
  return <CoachApp key={purpose} userId={userId} purpose={purpose} onExit={onExit} autoStartCamera={autoStartCamera} sessionId={sessionId} workout={workout} />
}
