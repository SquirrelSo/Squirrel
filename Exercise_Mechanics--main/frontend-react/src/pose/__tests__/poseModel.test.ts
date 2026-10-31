/* poseModel.test.ts — the WASM runtime is sourced from the installed tasks-vision package. */
import { describe, it, expect } from 'vitest'
import { WASM_FILES, wasmFilesFor } from '../poseModel'

describe('pose WASM sourcing', () => {
  it('uses the bundled package files, not a hard-coded CDN version', () => {
    for (const files of Object.values(WASM_FILES)) {
      expect(files.wasmLoaderPath).not.toMatch(/cdn\.jsdelivr|@mediapipe\/tasks-vision@/)
      expect(files.wasmBinaryPath).toMatch(/\.wasm/)
    }
  })

  it('selects the no-SIMD build when SIMD is unavailable', () => {
    expect(wasmFilesFor(true).wasmBinaryPath).toMatch(/vision_wasm_internal/)
    expect(wasmFilesFor(false).wasmBinaryPath).toMatch(/vision_wasm_nosimd_internal/)
  })
})
