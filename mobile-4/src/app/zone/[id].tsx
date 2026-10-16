import { StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { CAMPUS_MAP_ON_SERVICE } from '@/api/campus';
import { BattleList } from '@/components/campus/BattleList';
import { CampusMap } from '@/components/campus/CampusMap';
import { SourceBadge } from '@/components/campus/States';
import { ZonePanel } from '@/components/campus/ZonePanel';
import { Button, Header, Screen, tap } from '@/components/ui';
import { useCampusSession, useMe, useTerritorySync, useZones } from '@/hooks/useCampus';

/** One zone: its place on the map, owner, status, history, the allowed action, planning a meetup here, and its battles. */
export default function ZoneScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const zones = useZones();
  const me = useMe();
  useTerritorySync();
  const { signedIn } = useCampusSession();
  return (
    <Screen tabBar={false}>
      <Header back title="Zone" right={<SourceBadge />} />
      {!!zones.data?.length && <CampusMap zones={zones.data} meId={me.data?.user_id ?? null} selectedId={id} interactive={false} style={styles.map} />}
      <View style={{ marginTop: 14 }}>
        <ZonePanel zoneId={id} meId={me.data?.user_id ?? null} />
      </View>
      {/* Meetups are campus-service's (ADR-032): planned from a zone, with people you've crossed paths with. */}
      {CAMPUS_MAP_ON_SERVICE && signedIn && (
        <Button label="Plan a meetup here" variant="secondary" iconLeft="calendar-plus" onPress={() => { tap(); router.push({ pathname: '/meetup/new', params: { zoneId: id } }); }} style={{ marginTop: 14 }} />
      )}
      <BattleList zoneId={id} newBattle={{ label: 'New battle', params: { zoneId: id } }} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  map: { height: 220, marginTop: 8 },
});
