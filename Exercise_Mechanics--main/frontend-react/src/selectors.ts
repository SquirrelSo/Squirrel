/* selectors.ts — shared derived-state helpers read by multiple components.
   Previously isDimmed() was copy-pasted identically in Frames.tsx and Hud.tsx. */
import type { EngineState } from './types'
import { CONF_FLOOR } from './config'

/** Low-confidence, disconnected, or measurement-invalidated ⇒ the HUD holds its last values and
 *  dims them (never zero, never jump — handoff §A).
 *
 *  The third case is the one that does NOT show up as low confidence: a push-up filmed front-on
 *  has excellent landmark visibility, so without this the meters would keep rendering bright,
 *  live-looking numbers while the backend has stopped measuring entirely. Dimming is what tells
 *  the user those figures are frozen. */
export function isDimmed(s: EngineState): boolean {
  return s.trackingConfidence < CONF_FLOOR || s.disconnected || s.measurementBlockedBy.length > 0
}
