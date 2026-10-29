/* PushUpDemo.tsx — the demo-first entry screen (see App.tsx DEMO_PUSHUP).

   Holds nothing but the waiting/error state while demoSession.ts provisions the identity and the
   session; the real coach mounts straight afterwards, on its real setup gate. */
import { useEffect, useRef, useState } from 'react'
import { Q, TYPE } from '../tokens'
import type { WorkoutConfig } from '../types'
import { startPushUpDemo } from './demoSession'
import type { CachedUser } from './storage'

export function PushUpDemo(
  { onReady }: { onReady: (user: CachedUser, sessionId: string, workout: WorkoutConfig) => void },
) {
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  // StrictMode double-invokes effects in development; without this guard the demo would POST two
  // sessions on every mount and then start on the second one.
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    let cancelled = false;
    (async () => {
      try {
        const { user, sessionId, workout } = await startPushUpDemo()
        if (!cancelled) onReady(user, sessionId, workout)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not start the push-up demo.')
      }
    })()
    return () => { cancelled = true }
  }, [onReady, attempt])

  const retry = () => { started.current = false; setError(null); setAttempt((n) => n + 1) }

  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'grid', placeItems: 'center',
      background: '#070809', color: Q.neutral, padding: 24,
    }}>
      <div style={{ textAlign: 'center', maxWidth: 460 }}>
        <div style={{ ...TYPE.label, fontSize: 11, color: 'rgba(237,239,244,0.55)' }}>Push-up demo</div>
        <div style={{ ...TYPE.hero, fontSize: 38, margin: '10px 0 14px', color: error ? Q.red : Q.neutral }}>
          {error ? 'Could not start' : 'Preparing your set…'}
        </div>
        <div style={{ ...TYPE.body, fontSize: 15, lineHeight: 1.55, color: 'rgba(237,239,244,0.7)' }}>
          {error ?? 'Stand your device side-on, a few steps back, so your whole body is in frame.'}
        </div>
        {error && (
          <button onClick={retry} style={{
            marginTop: 22, padding: '13px 26px', borderRadius: 13, border: 'none',
            background: Q.green, color: '#08090c', ...TYPE.body, fontSize: 16, fontWeight: 700, cursor: 'pointer',
          }}>
            Try again
          </button>
        )}
      </div>
    </div>
  )
}
