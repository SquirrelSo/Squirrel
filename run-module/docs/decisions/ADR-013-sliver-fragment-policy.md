# ADR-013: Sliver Fragment Policy

## Status
Accepted

## Context
When a new run claims territory (RM-5.1), it carves overlapping geometries of existing active territories using `ST_Difference`. This process frequently produces geometric slivers — tiny leftover polygons under the minimum viable area threshold that clutter the grid and degrade query performance while offering no gameplay value. A multi-face geometry carved by a new capture can easily fragment into one main usable remainder and several tiny slivers. 

## Decision
1. **Shared Threshold**: We will reuse `MIN_TERRITORY_AREA_M2` (500) defined in `geometry/constants.ts` as the cutoff. A fragment too small to claim as a new territory is too small to keep as a remainder. One number, one rule.
2. **Sliver Discarding**: After `ST_Difference`, we use `ST_Dump` to break the resulting MultiPolygon into its constituent parts. Any individual part with a geographic area strictly less than `MIN_TERRITORY_AREA_M2` is discarded. The surviving parts are reunited using `ST_Multi(ST_Union(...))`.
3. **Tracking the Discarded**: The `captureTerritory` return payload is extended to include `slivers_discarded` (the count of dropped parts) and `sliver_area_m2` (the total physical area lost). This ensures total area conservation remains auditable, explaining why a carved territory shrank by *more* than the captured overlapping area.
4. **Full Consumption Fallback**: If *all* constituent parts of a carved territory are discarded as slivers, the territory is considered fully consumed. It is marked as `expired` with `fullyConsumed: true`. The row is **not deleted**; its geometry is retained in an expired state to support historical tracking and future capture event attribution.
5. **New Territories Exempt**: The new territory being claimed is *not* sliver-filtered during capture. It is assumed to have already passed the minimum validation gates in earlier pipeline stages.

## Consequences
- Reduces grid clutter and improves spatial query speeds by aggressively pruning irrelevant slivers.
- A user's territory area will sometimes decrease by more than the area captured by a rival.
- Area conservation checks must now account for `sliver_area_m2` in the balance equation.
