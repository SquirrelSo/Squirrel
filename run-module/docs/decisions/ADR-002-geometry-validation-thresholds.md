# ADR-002: Geometry Validation Thresholds

| Field        | Value                                            |
|-------------|--------------------------------------------------|
| **Status**   | Accepted                                         |
| **Date**     | 2026-09-19                                       |
| **Ticket**   | RM-2.5                                           |
| **Authors**  | Run Module team                                  |
| **Supersedes** | —                                              |

---

## Context

RM-2.5 introduces three validation gates that every polygonized geometry
must pass before being eligible to become a territory:

1. **Geometric validity** — the geometry must be a well-formed polygon or
   multipolygon as defined by the OGC Simple Features specification.
2. **Minimum area** — the enclosed area must meet a floor value.
3. **Isoperimetric sanity** — the relationship between area and perimeter
   must be physically plausible.

Two of these gates (minimum area and isoperimetric tolerance) require numeric
thresholds.  Those thresholds are engineering decisions.  **No Technical
Specification document currently exists** to carry these values; they are
recorded here so the decision is auditable and can be updated when the spec
is written.

---

## Decision

### Threshold 1 — Minimum territory area: 500 m²

| | |
|---|---|
| **Constant** | `MIN_TERRITORY_AREA_M2 = 500` |
| **Source** | Implementation Guide section 5.3, RM-2.5's acceptance criteria |
| **Rationale** | 500 m² corresponds to a roughly 22 m x 22 m patch — small enough to be a legitimate capture for a tight urban run, but large enough to exclude microfaces produced by self-intersections at crossings.  Microfaces typically have areas of 0.01–10 m² (area of the crossing sliver) and are reliably below this floor.  The value comes directly from the spec and is not an engineering choice; it is recorded here for traceability. |

### Threshold 2 — Isoperimetric tolerance: 1.05

| | |
|---|---|
| **Constant** | `ISOPERIMETRIC_TOLERANCE = 1.05` |
| **Source** | Engineering decision (no spec reference) |
| **Rationale** | The classical isoperimetric inequality states that for any closed curve of perimeter P enclosing area A: <br><br> `A ≤ P² / (4π)` <br><br> with equality only for a perfect circle.  The gate enforces that area must not exceed `(P² / 4π) * 1.05`. This is an UPPER BOUND ON AREA that rejects geometrically impossible shapes — area larger than any closed curve of that perimeter could enclose. It is a data-integrity net against fabricated geometry, NOT a fatness or stick filter. <br><br> The gate exists as a **sanity check against data corruption**. Scenarios where a violation could occur: the area was computed in a projection with a different scale factor than the perimeter; a client-supplied area value was substituted; or reprojection between AEQD and EPSG:4326 introduced large distortion. <br><br> **Why 1.05?** A tolerance of 1.00 would reject a valid near-circular polygon due to PostGIS floating-point rounding. 1.05 (5% headroom) absorbs floating-point error and sub-percent reprojection distortion while remaining sensitive to gross data inconsistencies. |

---

## Consequences

### Positive
- Both thresholds are now documented and version-controlled.
- Changing a threshold requires editing a single constant in `constants.ts`.
- The isoperimetric gate catches data-pipeline bugs that would otherwise
  silently produce impossible territories.
- Out-and-back fixtures produce one polygon with the tail discarded as a dangling edge, accepted and finalized with one face.
- Rejection reasons are stored in `run_rejections`, allowing analysis of failed runs.

### Negative / Risks
- `MIN_TERRITORY_AREA_M2 = 500` is imported from the spec without a formal
  spec document to cite.

---

*Corrected 2026-09-19: Fixed the isoperimetric gate direction to correctly describe an upper bound on area rather than a fatness filter, removed the inaccurate claim about out-and-back runs being rejected (they are accepted), and clarified that rejection reasons are stored in run_rejections.*
