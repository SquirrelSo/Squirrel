/* The demo entry skips four screens of the normal flow, so what it hands the coach has to be
   indistinguishable from what the Solo builder would have handed it — a persisted session id and
   the normalized plan the BACKEND stored, not the one the client asked for. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEMO_PUSHUP_EXERCISE, startPushUpDemo } from './demoSession'

type Call = { url: string; body: unknown }

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k) },
    setItem: (k: string, v: string) => { map.set(k, v) },
  } as Storage
}

let calls: Call[] = []

function stubFetch(responses: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const key = Object.keys(responses).find((k) => url.includes(k))
    if (!key) throw new Error(`unexpected request: ${url}`)
    return { ok: true, json: async () => responses[key] } as Response
  }))
}

/* Responds to each matching request from a queue, so one url can answer differently on the first
   and second call — which is what recovering from a stale identity looks like on the wire. */
function stubFetchSequence(script: { match: string; ok: boolean; status?: number; body: unknown }[]) {
  const queue = [...script]
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const i = queue.findIndex((s) => url.includes(s.match))
    if (i === -1) throw new Error(`unexpected request: ${url}`)
    const [step] = queue.splice(i, 1)
    return { ok: step.ok, status: step.status ?? 200, json: async () => step.body } as Response
  }))
}

const CREATED_USER = { user_id: 'u_demo', first_name: 'Demo', last_name: 'User' }
const CREATED_SESSION = {
  session_id: 's_1',
  exercise_id: 'pushup',
  exercise_name: 'Push-up',
  variant: null,
  sets: 1,
  target: { type: 'reps', value: 5 },
  rest_seconds: 60,
}

beforeEach(() => {
  calls = []
  vi.stubGlobal('localStorage', memoryStorage())
})

afterEach(() => { vi.unstubAllGlobals() })

describe('push-up demo provisioning', () => {
  it('creates a profile and a push-up session, and returns the persisted plan', async () => {
    stubFetch({ '/api/users/': CREATED_SESSION, '/api/users': CREATED_USER })
    const { user, sessionId, workout } = await startPushUpDemo()

    expect(user).toEqual(CREATED_USER)
    expect(sessionId).toBe('s_1')
    // The exercise id has to be the backend's canonical slug — it is what /ws/setup and /ws/train
    // are opened with, so a wrong value here starts the wrong exercise's rules.
    expect(workout.exerciseId).toBe('pushup')
    expect(workout.measure).toBe('reps')
    expect(workout.reps).toBe(5)
    expect(workout.sets).toBe(1)

    const post = calls.find((c) => c.url.includes('/sessions'))
    expect(post?.body).toEqual({ exercises: [DEMO_PUSHUP_EXERCISE] })
  })

  it('reuses the profile already cached on this device instead of minting another', async () => {
    localStorage.setItem('fitsync_user', JSON.stringify(CREATED_USER))
    stubFetch({ '/sessions': CREATED_SESSION })
    const { user } = await startPushUpDemo()

    expect(user).toEqual(CREATED_USER)
    // A reload that created a new user each time would abandon the saved baseline with it.
    expect(calls.filter((c) => c.url.endsWith('/api/users'))).toHaveLength(0)
  })

  it('takes the backend plan over what it asked for when the two differ', async () => {
    // The request asks for 5; the stored plan says 3. The coach must run the stored one.
    stubFetch({
      '/api/users/': { ...CREATED_SESSION, sets: 2, target: { type: 'reps', value: 3 } },
      '/api/users': CREATED_USER,
    })
    const { workout } = await startPushUpDemo()
    expect(workout.reps).toBe(3)
    expect(workout.sets).toBe(2)
  })

  it('recovers when the cached identity no longer exists on the server', async () => {
    // Exactly what happens when a container with an empty data/users/ takes over the port a local
    // backend was on: the browser still points at a profile that is not there any more.
    localStorage.setItem('fitsync_user', JSON.stringify({ ...CREATED_USER, user_id: 'u_gone' }))
    stubFetchSequence([
      { match: '/users/u_gone/sessions', ok: false, status: 404, body: { detail: 'user not found' } },
      { match: '/api/users', ok: true, body: CREATED_USER },
      { match: '/sessions', ok: true, body: CREATED_SESSION },
    ])

    const { user, sessionId } = await startPushUpDemo()
    expect(user).toEqual(CREATED_USER)
    expect(sessionId).toBe('s_1')
    // And the replacement is cached, so the next reload does not repeat the round trip.
    expect(JSON.parse(localStorage.getItem('fitsync_user') ?? 'null')).toEqual(CREATED_USER)
  })

  it('does not mint users to paper over a server failure', async () => {
    localStorage.setItem('fitsync_user', JSON.stringify(CREATED_USER))
    stubFetchSequence([
      { match: '/sessions', ok: false, status: 500, body: { detail: 'session store unavailable' } },
    ])
    await expect(startPushUpDemo()).rejects.toThrow('session store unavailable')
    expect(calls.filter((c) => c.url.endsWith('/api/users'))).toHaveLength(0)
  })

  it('propagates a failure rather than starting a set with no session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ detail: 'session store unavailable' }),
    } as Response)))
    await expect(startPushUpDemo()).rejects.toThrow()
  })
})
