/**
 * Compact campus map (welcome, run, zone screens): the same world renderer as the Map tab,
 * without players. Kept as a thin wrapper so existing call sites don't change.
 */
import type { StyleProp, ViewStyle } from 'react-native';
import type { LatLng, Zone } from '@/api/campus';
import { WorldMap } from '@/components/map/WorldMap';
import { useMapFeatures } from '@/hooks/useCampus';

export type CampusMapProps = {
  zones: Zone[];
  meId: string | null;
  selectedId?: string | null;
  onSelect?: (zoneId: string) => void;
  route?: LatLng[];
  me?: LatLng | null;
  interactive?: boolean;
  style?: StyleProp<ViewStyle>;
  highlight?: string[];
};

export function CampusMap({ zones, meId, selectedId = null, onSelect, route, me, interactive = true, style, highlight }: CampusMapProps) {
  const features = useMapFeatures();
  return <WorldMap zones={zones} features={features.data} meId={meId} selectedZoneId={selectedId} onSelectZone={onSelect} route={route} me={me ?? null} interactive={interactive} style={style} highlight={highlight} />;
}
