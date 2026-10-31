/* Sign-up page 2. The rules under test: nothing sensitive is sent without its consent box ticked,
   an untouched page sends nothing, and the payload matches what the backend accepts. */
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  EMPTY_DETAILS, POLICY_VERSION, detailsErrors, detailsPayload, saveSignUpDetails, toggle,
  type DetailsDraft,
} from './profileDetailsApi'
import { ProfileDetailsForm, type ProfileDetailsFormProps } from './ProfileDetails'

const draft = (over: Partial<DetailsDraft> = {}): DetailsDraft => ({ ...EMPTY_DETAILS, ...over })

describe('detailsPayload', () => {
  it('sends nothing when nothing was answered', () => {
    expect(detailsPayload(EMPTY_DETAILS)).toBeNull()
  })

  it('sends fitness and activities without any consent', () => {
    expect(detailsPayload(draft({ fitnessLevel: 'intermediate', primaryGoal: 'endurance', activities: ['running', 'yoga'] })))
      .toEqual({
        fitness: { fitness_level: 'intermediate', activity_level: null, primary_goal: 'endurance' },
        activities: [{ activity: 'running' }, { activity: 'yoga' }],
      })
  })

  it('never sends physique or habits while their consent box is unticked', () => {
    const p = detailsPayload(draft({ bodyType: 'slim', workoutTimes: ['morning'], diet: 'vegan', activities: ['yoga'] }))
    expect(p).toEqual({ activities: [{ activity: 'yoga' }] })
  })

  it('sends a sensitive section together with its consent grant', () => {
    const p = detailsPayload(draft({
      physiqueConsent: true, bodyType: 'athletic',
      habitsConsent: true, workoutTimes: ['evening'], workoutsPerWeek: '4', sleepHours: '7.5', smoking: 'never',
    }))
    expect(p?.physique).toEqual({ body_type: 'athletic' })
    expect(p?.habits).toEqual({
      preferred_workout_times: ['evening'], workouts_per_week_goal: 4, avg_sleep_hours: 7.5,
      diet: null, smoking: 'never', alcohol: null,
    })
    expect(p?.consents).toEqual([
      { category: 'physique', granted: true, policy_version: POLICY_VERSION },
      { category: 'habits', granted: true, policy_version: POLICY_VERSION },
    ])
  })

  it('does not grant consent for a ticked box with nothing answered', () => {
    expect(detailsPayload(draft({ physiqueConsent: true, habitsConsent: true }))).toBeNull()
  })
})

describe('detailsErrors', () => {
  it('accepts an empty page', () => {
    expect(detailsErrors(EMPTY_DETAILS)).toEqual({})
  })

  it('needs a fitness level once the other fitness questions are answered', () => {
    expect(detailsErrors(draft({ primaryGoal: 'lose_fat' })).fitness).toBeDefined()
    expect(detailsErrors(draft({ primaryGoal: 'lose_fat', fitnessLevel: 'beginner' })).fitness).toBeUndefined()
  })

  it('asks for an answer, or an untick, when a consent box is ticked', () => {
    const e = detailsErrors(draft({ physiqueConsent: true, habitsConsent: true }))
    expect(e.physique).toBeDefined()
    expect(e.habits).toBeDefined()
  })

  it('checks the number ranges the backend enforces', () => {
    const bad = detailsErrors(draft({ habitsConsent: true, workoutsPerWeek: '15', sleepHours: '17' }))
    expect(bad.workoutsPerWeek).toBeDefined()
    expect(bad.sleepHours).toBeDefined()
    expect(detailsErrors(draft({ habitsConsent: true, workoutsPerWeek: '2.5' })).workoutsPerWeek).toBeDefined()
    expect(detailsErrors(draft({ habitsConsent: true, workoutsPerWeek: '0', sleepHours: '16' }))).toEqual({})
  })

  it('ignores numbers typed into an unticked habits section', () => {
    expect(detailsErrors(draft({ workoutsPerWeek: '99' }))).toEqual({})
  })
})

describe('saveSignUpDetails', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('PUTs the payload to the details route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await saveSignUpDetails('ana-tester-abc123', { activities: [{ activity: 'yoga' }] })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/users/ana-tester-abc123/details')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ activities: [{ activity: 'yoga' }] })
  })

  it("surfaces the backend's message", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ detail: { code: 'consent_required', message: 'Turn on consent first.' } }), { status: 403 })))
    await expect(saveSignUpDetails('u', {})).rejects.toThrow('Turn on consent first.')
  })

  it('explains a validation failure plainly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: [{ msg: 'x' }] }), { status: 422 })))
    await expect(saveSignUpDetails('u', {})).rejects.toThrow("Some answers weren't accepted")
  })
})

describe('rendering', () => {
  const render = (over: Partial<ProfileDetailsFormProps> = {}) => renderToStaticMarkup(
    <ProfileDetailsForm firstName="Ana" draft={EMPTY_DETAILS} onDraft={() => {}} errors={{}} saving={false}
      serverError={null} onFinish={() => {}} onSkip={() => {}} {...over} />,
  )

  it('is step 2 of 2, can be skipped, and greets the new user', () => {
    const html = render()
    expect(html).toContain('Step 2 of 2')
    expect(html).toContain('Nice to meet you, Ana')
    expect(html).toContain('Skip for now')
    expect(html).toContain('Finish')
  })

  it('hides the sensitive questions until their consent box is ticked', () => {
    const closed = render()
    expect(closed).toContain('Save my physique details')
    expect(closed).not.toContain('Body type')
    expect(closed).not.toContain('Sleep per night')
    const open = render({ draft: draft({ physiqueConsent: true, habitsConsent: true }) })
    expect(open).toContain('Body type')
    expect(open).toContain('Sleep per night')
  })

  it('shows errors and the server message', () => {
    const html = render({ draft: draft({ physiqueConsent: true }), errors: { physique: 'Pick a body type.' }, serverError: 'Down.' })
    expect(html).toContain('Pick a body type.')
    expect(html).toContain('Down.')
  })

  it('marks picked chips', () => {
    const html = render({ draft: draft({ activities: ['yoga'], fitnessLevel: 'advanced' }) })
    expect(html).toMatch(/v2-libchip--active"[^>]*>Yoga/)
    expect(html).toMatch(/aria-checked="true"[^>]*>Advanced/)
  })
})

it('toggle adds and removes', () => {
  expect(toggle(['a'], 'b')).toEqual(['a', 'b'])
  expect(toggle(['a', 'b'], 'a')).toEqual(['b'])
})
