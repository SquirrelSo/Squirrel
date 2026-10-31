/* Partner Hunt screen logic. The rules under test mirror the backend's: which state a user is in,
   what counts as valid preferences, and — most of all — that "XP service down" is never shown as
   "not enough XP". */
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_PREFERENCES, PartnerHuntApiError, fetchPartnerMatches, partnerView, preferenceErrors,
  preferencesPayload, savePartnerPreferences, toggle,
  type PartnerMatch, type PartnerPreferences, type PartnerStatus,
} from './partnerHuntApi'
import { MatchCard, PartnerBoard, PartnerHuntScreen, type PartnerHuntScreenProps } from './PartnerHunt'

const PREFS: PartnerPreferences = {
  visible: true,
  activities: ['running'],
  mode: 'either',
  city: 'Pune',
  preferred_times: ['morning'],
  partner_genders: [],
  partner_age_min: 18,
  partner_age_max: 45,
}

function status(overrides: Partial<PartnerStatus> = {}): PartnerStatus {
  return {
    min_xp: 100,
    xp: { available: true, xp: 150, updated_at: null },
    unlocked: true,
    age_eligible: true,
    fitness_level: 'intermediate',
    preferences: PREFS,
    ready: true,
    ...overrides,
  }
}

const MATCH: PartnerMatch = {
  user_id: 'ben-tester-abc123',
  display_name: 'Ben T.',
  age_band: '25–34',
  fitness_level: 'intermediate',
  shared_activities: ['running'],
  shared_times: ['morning'],
  meet: ['in_person', 'remote'],
  city: 'Pune',
  score: 92,
  reasons: ['Both into running', 'Both train mornings'],
}

describe('which state to show', () => {
  it('unlocked, visible and set up → the board', () => {
    expect(partnerView(status())).toEqual({ kind: 'board' })
  })

  it('shows XP progress while locked, clamped at the ends', () => {
    expect(partnerView(status({ unlocked: false, xp: { available: true, xp: 40, updated_at: null } })))
      .toEqual({ kind: 'locked', xp: 40, minXp: 100, remaining: 60, progress: 0.4 })
    // A gate that says no to someone above the threshold (the Run Module may add conditions) must
    // not show a negative remainder or an overfull bar.
    expect(partnerView(status({ unlocked: false, xp: { available: true, xp: 130, updated_at: null } })))
      .toMatchObject({ kind: 'locked', remaining: 0, progress: 1 })
  })

  it('never shows an unreachable XP service as "not enough XP"', () => {
    const down = status({ unlocked: false, xp: { available: false, xp: null, updated_at: null } })
    expect(partnerView(down)).toEqual({ kind: 'xp_unavailable' })
  })

  it('checks age before anything else, like the server', () => {
    const minor = status({ age_eligible: false, unlocked: false, xp: { available: false, xp: null, updated_at: null } })
    expect(partnerView(minor)).toEqual({ kind: 'age_restricted' })
  })

  it('asks for setup when preferences are missing or hidden', () => {
    expect(partnerView(status({ preferences: null }))).toEqual({ kind: 'setup' })
    expect(partnerView(status({ preferences: { ...PREFS, visible: false } }))).toEqual({ kind: 'setup' })
  })
})

describe('preference validation', () => {
  it('accepts a complete set', () => {
    expect(preferenceErrors(PREFS)).toEqual({})
  })

  it('explains each problem', () => {
    const errors = preferenceErrors({
      ...PREFS, activities: [], preferred_times: [], mode: 'in_person', city: '  ', partner_age_min: 40, partner_age_max: 30,
    })
    expect(Object.keys(errors).sort()).toEqual(['activities', 'age', 'city', 'preferred_times'])
    expect(errors.age).toMatch(/minimum/)
  })

  it('does not need a city for remote-only', () => {
    expect(preferenceErrors({ ...PREFS, mode: 'remote', city: '' })).toEqual({})
  })

  it('rejects ages outside 18–99 and empty age boxes', () => {
    expect(preferenceErrors({ ...PREFS, partner_age_min: 16 }).age).toBeDefined()
    expect(preferenceErrors({ ...PREFS, partner_age_max: Number.NaN }).age).toBeDefined()
  })

  it('a fresh form starts invalid, so nothing is saved by accident', () => {
    expect(Object.keys(preferenceErrors(DEFAULT_PREFERENCES)).sort()).toEqual(['activities', 'city', 'preferred_times'])
  })

  it('never sends a location that is not needed', () => {
    expect(preferencesPayload({ ...PREFS, mode: 'remote', city: 'Pune' }).city).toBeNull()
    expect(preferencesPayload({ ...PREFS, city: '  Pune ' }).city).toBe('Pune')
  })

  it('toggles list membership', () => {
    expect(toggle(['a', 'b'], 'a')).toEqual(['b'])
    expect(toggle(['a'], 'b')).toEqual(['a', 'b'])
  })
})

describe('API client', () => {
  afterEach(() => vi.unstubAllGlobals())

  function stubFetch(status: number, body: unknown) {
    const fetchMock = vi.fn(async () => ({ ok: status < 400, status, json: async () => body }) as Response)
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('surfaces the backend error code, not just a message', async () => {
    stubFetch(403, { detail: { code: 'xp_locked', message: 'Partner Hunt opens at 100 XP.', xp: 40, min_xp: 100 } })
    const error = await fetchPartnerMatches('ana').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PartnerHuntApiError)
    expect(error).toMatchObject({ status: 403, code: 'xp_locked', message: 'Partner Hunt opens at 100 XP.' })
  })

  it('turns request validation errors into a readable message', async () => {
    stubFetch(422, { detail: [{ msg: 'Value error, a city is required to meet in person' }] })
    const error = await savePartnerPreferences('ana', PREFS).catch((e: unknown) => e)
    expect(error).toMatchObject({ status: 422, code: 'invalid', message: 'Value error, a city is required to meet in person' })
  })

  it('saves with the city stripped for remote-only and the user id encoded', async () => {
    const fetchMock = stubFetch(200, PREFS)
    await savePartnerPreferences('ana/../x', { ...PREFS, mode: 'remote' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/users/ana%2F..%2Fx/partner-hunt/preferences')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body)).city).toBeNull()
  })
})

describe('rendering', () => {
  function screen(overrides: Partial<PartnerHuntScreenProps>): string {
    const props: PartnerHuntScreenProps = {
      view: { kind: 'board' }, loadError: null, onRetry: () => {}, draft: PREFS, onDraft: () => {}, errors: {},
      saving: false, saveError: null, onSave: () => {}, editing: false, onEdit: () => {},
      hasSavedPreferences: true, matches: [MATCH], matchesError: null, onBlock: () => {},
      ...overrides,
    }
    return renderToStaticMarkup(<PartnerHuntScreen {...props} />)
  }

  it('locked: shows progress to 100 XP and still lets the user set up', () => {
    const html = screen({ view: { kind: 'locked', xp: 40, minXp: 100, remaining: 60, progress: 0.4 }, hasSavedPreferences: false })
    expect(html).toContain('Unlocks at 100 XP')
    expect(html).toContain('60 XP to go')
    expect(html).toContain('width:40%')
    expect(html).toContain('Set up while you unlock')
    expect(html).not.toContain('Ben T.')
  })

  it('XP service down: says it is not the user’s fault and never mentions XP to go', () => {
    const html = screen({ view: { kind: 'xp_unavailable' } })
    expect(html).toContain('couldn')
    expect(html).toContain('This isn')
    expect(html).not.toContain('XP to go')
    expect(html).not.toContain('Ben T.')
  })

  it('under 18: no form, no board', () => {
    const html = screen({ view: { kind: 'age_restricted' } })
    expect(html).toContain('18 and over')
    expect(html).not.toContain('Save preferences')
    expect(html).not.toContain('Ben T.')
  })

  it('setup: explains that browsing requires being visible', () => {
    const html = screen({ view: { kind: 'setup' } })
    expect(html).toContain('visible to others')
    expect(html).toContain('Save preferences')
  })

  it('board: shows matches with reasons and an edit button', () => {
    const html = screen({})
    expect(html).toContain('Ben T.')
    expect(html).toContain('92% match')
    expect(html).toContain('Both into running')
    expect(html).toContain('Edit preferences')
  })

  it('shows a field error next to the field it belongs to', () => {
    const html = screen({ view: { kind: 'setup' }, draft: { ...PREFS, mode: 'in_person', city: '' }, errors: { city: 'Add your city to meet in person.' } })
    expect(html).toContain('Add your city to meet in person.')
  })

  it('hides the city field for remote-only', () => {
    expect(screen({ view: { kind: 'setup' }, draft: { ...PREFS, mode: 'remote' } })).not.toContain('ph-city')
    expect(screen({ view: { kind: 'setup' } })).toContain('ph-city')
  })

  it('an empty board says why, instead of looking broken', () => {
    const html = renderToStaticMarkup(<PartnerBoard matches={[]} error={null} onBlock={() => {}} />)
    expect(html).toContain('No matches yet')
  })

  it('a card offers Block, marks Connect as coming, and describes how they can meet', () => {
    const html = renderToStaticMarkup(<MatchCard match={MATCH} onBlock={() => {}} />)
    expect(html).toContain('Block')
    expect(html).toContain('Connect · Soon')
    expect(html).toContain('Can meet in Pune or train remotely')
    const remote = renderToStaticMarkup(<MatchCard match={{ ...MATCH, meet: ['remote'], city: null }} onBlock={() => {}} />)
    expect(remote).toContain('Remote training')
    expect(remote).not.toContain('Pune')
  })
})
