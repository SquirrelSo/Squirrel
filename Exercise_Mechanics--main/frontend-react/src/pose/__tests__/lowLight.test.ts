/* lowLight.test.ts — low-light preprocessing decisions (pure policy). */
import { describe, it, expect } from 'vitest'
import {
  LowLightPolicy, gainFor, meanLuma,
  LOWLIGHT_ENTER_LUMA, LOWLIGHT_EXIT_LUMA, MAX_GAIN, TOO_DARK_LUMA,
} from '../lowLight'

const settle = (p: LowLightPolicy, luma: number, n = 30) => { for (let i = 0; i < n; i++) p.update(luma) }

describe('meanLuma / gainFor', () => {
  it('computes Rec.601 luma over RGBA', () => {
    expect(meanLuma([255, 255, 255, 255, 0, 0, 0, 255])).toBeCloseTo(127.5)
    expect(meanLuma([])).toBe(0)
  })

  it('never darkens and caps the gain', () => {
    expect(gainFor(200)).toBe(1)
    expect(gainFor(20)).toBeCloseTo(5.5)
    expect(gainFor(0)).toBe(MAX_GAIN)
  })
})

describe('LowLightPolicy', () => {
  it('leaves normally lit frames untouched', () => {
    const p = new LowLightPolicy()
    settle(p, 120)
    expect(p.active).toBe(false)
    expect(p.lighting).toBe('ok')
  })

  it('enhances dark frames and reports low light', () => {
    const p = new LowLightPolicy()
    settle(p, 15)
    expect(p.active).toBe(true)
    expect(p.lighting).toBe('low')
    expect(p.gain).toBeGreaterThan(1)
  })

  it('uses hysteresis so it does not flicker around the threshold', () => {
    const p = new LowLightPolicy()
    settle(p, LOWLIGHT_ENTER_LUMA - 5)
    expect(p.active).toBe(true)
    settle(p, (LOWLIGHT_ENTER_LUMA + LOWLIGHT_EXIT_LUMA) / 2)
    expect(p.active).toBe(true)
    settle(p, LOWLIGHT_EXIT_LUMA + 10)
    expect(p.active).toBe(false)
  })

  it('asks for more light when the scene is beyond rescue', () => {
    const p = new LowLightPolicy()
    settle(p, TOO_DARK_LUMA - 3)
    expect(p.lighting).toBe('too_dark')
  })

  it('honours forced modes', () => {
    const on = new LowLightPolicy('on'); settle(on, 150)
    const off = new LowLightPolicy('off'); settle(off, 5)
    expect(on.active).toBe(true)
    expect(off.active).toBe(false)
    expect(off.lighting).toBe('too_dark') // the hint is still honest when enhancement is off
  })

  it('ignores non-finite samples', () => {
    const p = new LowLightPolicy()
    p.update(Number.NaN)
    expect(p.luma).toBeNull()
    expect(p.lighting).toBe('ok')
  })
})
