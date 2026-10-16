/**
 * Activity heatmap layer: soft glows drawn in world space (metres), inside the map's SVG, above
 * zone fills and below markers. It only renders Dev B's aggregated cells — no maths on raw
 * activity here — and it's memoised, so panning and GPS updates never re-render it.
 */
import { memo } from 'react';
import { Circle, Defs, G, RadialGradient, Stop } from 'react-native-svg';
import type { HeatCell, HeatLevel } from '@/api/campus/types';
import type { Projection } from '@/components/map/geometry';
import { colors } from '@/theme';

/** Level → colour role: violet (low), pink (active), lime-hot core (high). Labels ship alongside. */
export const HEAT_UI: Record<HeatLevel, { label: string; color: string }> = {
  low: { label: 'Low activity', color: colors.purple },
  active: { label: 'Active', color: colors.secondary },
  high: { label: 'High activity', color: colors.primary },
};

function HeatLayerImpl({ cells, proj }: { cells: HeatCell[]; proj: Projection }) {
  return (
    <G pointerEvents="none">
      <Defs>
        <RadialGradient id="heat-low" cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor={colors.purple} stopOpacity={0.7} />
          <Stop offset="1" stopColor={colors.purple} stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id="heat-active" cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor={colors.secondary} stopOpacity={0.85} />
          <Stop offset="0.6" stopColor={colors.secondary} stopOpacity={0.32} />
          <Stop offset="1" stopColor={colors.secondary} stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id="heat-high" cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor={colors.primary} stopOpacity={0.95} />
          <Stop offset="0.35" stopColor={colors.secondary} stopOpacity={0.6} />
          <Stop offset="1" stopColor={colors.secondary} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      {cells.map((c) => {
        const [x, y] = proj.project(c.center);
        return <Circle key={c.id} cx={x} cy={y} r={Math.max(20, c.radius_m)} fill={`url(#heat-${c.level})`} opacity={0.55 + 0.45 * Math.max(0, Math.min(1, c.intensity))} />;
      })}
    </G>
  );
}

export const HeatLayer = memo(HeatLayerImpl);
