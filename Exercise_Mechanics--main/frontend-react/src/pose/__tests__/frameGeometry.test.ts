/* frameGeometry.test.ts — keypoints are resolution-independent and unchanged at 1280×720. */
import { describe, it, expect } from 'vitest'
import { canonicalScale, toCanonicalKeypoints, CANONICAL_LONG_SIDE_PX } from '../frameGeometry'
import { LANDMARK_NAMES } from '../landmarks'
import type { Landmark } from '../../types'

const pose = (x: number, y: number, z = 0, visibility = 0.9): Landmark[] =>
  LANDMARK_NAMES.map(() => ({ x, y, z, visibility }))

describe('canonicalScale', () => {
  it('is 1 for the reference 1280×720 stream (existing baselines stay valid)', () => {
    expect(canonicalScale(1280, 720)).toBe(1)
    expect(canonicalScale(720, 1280)).toBe(1)
  })

  it('scales lower-resolution Android streams up to the same units', () => {
    expect(canonicalScale(640, 480)).toBe(2)
    expect(canonicalScale(480, 640)).toBe(2)
    expect(canonicalScale(960, 540)).toBeCloseTo(4 / 3)
  })

  it('is null before the video has a size', () => {
    expect(canonicalScale(0, 0)).toBeNull()
    expect(canonicalScale(640, 0)).toBeNull()
  })
})

describe('toCanonicalKeypoints', () => {
  it('matches the previous pixel mapping exactly at 1280×720', () => {
    const kp = toCanonicalKeypoints(pose(0.25, 0.5, -0.1, 0.87654), 1280, 720)!
    expect(kp.nose).toEqual({ x: 320, y: 360, z: -128, v: 0.877 })
    expect(Object.keys(kp)).toEqual([...LANDMARK_NAMES])
  })

  it('gives the same body the same size on a 640×480 camera as on a 1280×960 one', () => {
    const shoulders = (w: number, h: number) => {
      const lms = pose(0.5, 0.5)
      lms[11] = { ...lms[11], x: 0.4 }
      lms[12] = { ...lms[12], x: 0.6 }
      const kp = toCanonicalKeypoints(lms, w, h)!
      return Math.abs(kp.left_shoulder.x - kp.right_shoulder.x)
    }
    expect(shoulders(640, 480)).toBe(shoulders(1280, 960))
  })

  it('preserves aspect ratio (uniform scale) in portrait', () => {
    const kp = toCanonicalKeypoints(pose(1, 1), 480, 640)!
    expect(kp.nose.y).toBe(CANONICAL_LONG_SIDE_PX)
    expect(kp.nose.x).toBe(960)
  })

  it('refuses to produce keypoints before the video has a size', () => {
    expect(toCanonicalKeypoints(pose(0.5, 0.5), 0, 0)).toBeNull()
  })
})
