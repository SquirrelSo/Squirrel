/* camera.test.ts — orientation-aware constraints and fallback on device quirks. */
import { describe, it, expect, vi } from 'vitest'
import { acquireCameraStream, cameraConstraintAttempts } from '../camera'

const named = (name: string) => Object.assign(new Error(name), { name })

describe('cameraConstraintAttempts', () => {
  it('requests the orientation the phone is held in, without forcing a crop', () => {
    const [portrait] = cameraConstraintAttempts(true)
    const v = portrait.video as MediaTrackConstraints & { resizeMode?: unknown }
    expect(v.width).toEqual({ ideal: 720 })
    expect(v.height).toEqual({ ideal: 1280 })
    expect(v.resizeMode).toEqual({ ideal: 'none' })
    expect(v.frameRate).toEqual({ ideal: 30 })
    const [landscape] = cameraConstraintAttempts(false)
    expect((landscape.video as MediaTrackConstraints).width).toEqual({ ideal: 1280 })
  })
})

describe('acquireCameraStream', () => {
  it('falls back to plainer constraints when the device rejects the tuned request', async () => {
    const stream = {} as MediaStream
    const gum = vi.fn()
      .mockRejectedValueOnce(named('OverconstrainedError'))
      .mockResolvedValueOnce(stream)
    await expect(acquireCameraStream(gum, true)).resolves.toBe(stream)
    expect(gum).toHaveBeenCalledTimes(2)
    expect(gum.mock.calls[1][0]).toEqual({ video: { facingMode: 'user' }, audio: false })
  })

  it('surfaces permission denial immediately (never retried)', async () => {
    const gum = vi.fn().mockRejectedValue(named('NotAllowedError'))
    await expect(acquireCameraStream(gum, false)).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(gum).toHaveBeenCalledTimes(1)
  })

  it('reports the last error when every attempt fails', async () => {
    const gum = vi.fn().mockRejectedValue(named('NotReadableError'))
    await expect(acquireCameraStream(gum, false)).rejects.toMatchObject({ name: 'NotReadableError' })
    expect(gum).toHaveBeenCalledTimes(3)
  })
})
