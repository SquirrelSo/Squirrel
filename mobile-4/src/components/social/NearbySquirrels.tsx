/** Social tab strip: a few Squirrels nearby with Poke, linking to the Map for the rest. */
import { View } from 'react-native';
import { router } from 'expo-router';
import { NearbyUserCard } from '@/components/social/NearbyUserCard';
import { SectionHeader } from '@/components/ui';
import { useNearbyPlayers } from '@/hooks/useMap';

export function NearbySquirrels({ max = 3 }: { max?: number }) {
  const r = useNearbyPlayers();
  // Optional section: hidden when there's nothing (or nothing loaded) rather than nagging.
  const list = (r.data?.players ?? []).filter((p) => p.relationship !== 'friends').slice(0, max);
  if (!list.length) return null;
  return (
    <View style={{ marginBottom: 14 }}>
      <SectionHeader title="Squirrels near you" action="Map" onAction={() => router.push('/explore')} />
      <View style={{ gap: 8 }}>
        {list.map((p) => (
          <NearbyUserCard key={p.user_id} person={p} />
        ))}
      </View>
    </View>
  );
}
