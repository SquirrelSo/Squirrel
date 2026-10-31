/**
 * YOUR SHARED ZONES — everyone you've shared ground with, most overlap first (Dev B's
 * GET /v1/me/shared-zones). Virtualised: this list grows with the campus.
 * A hidden / emptied list says why (`hidden_code`): Retry when the block list couldn't be checked
 * (the list comes back empty, fail-closed, even while visible), Settings for Open to Meet.
 */
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { getSharedZonesIndex } from '@/api/campus/discovery';
import { hiddenActionFor } from '@/api/campus/campusShapes';
import type { SharedZonesIndex, SharedZonesPerson } from '@/api/campus/types';
import { PersonAvatar } from '@/components/campus/PersonAvatar';
import { EmptyNote, ErrorState, LoadingRows, SourceBadge } from '@/components/campus/States';
import { PRIVACY_LINE } from '@/components/discovery/SharedZones';
import { Display, Header, Icon, Kicker, PressScale, Screen } from '@/components/ui';
import { useCampus, useRefreshOnFocus } from '@/hooks/useCampus';
import { colors, fonts, radius } from '@/theme';

export default function SharedZonesIndexScreen() {
  const r = useCampus<SharedZonesIndex>('shared-zones', () => getSharedZonesIndex());
  useRefreshOnFocus(r.reload, 60_000);
  const d = r.data;
  const hiddenAction = hiddenActionFor(d?.hidden_code);

  const head = (
    <>
      <Header back title="" right={<SourceBadge />} />
      <Kicker color={colors.secondary}>Shared zones</Kicker>
      <Display size={38} style={{ marginTop: 4 }}>
        Same ground,{'\n'}
        <Text style={{ color: colors.primary }}>new people.</Text>
      </Display>
      <Text style={styles.sub}>Squirrels who’ve been active in the same zones as you.</Text>
    </>
  );

  if (!d) {
    return (
      <Screen tabBar={false}>
        {head}
        {r.error ? <ErrorState cause={r.cause} onRetry={r.reload} feature="Shared zones" /> : <LoadingRows rows={4} height={68} style={{ marginTop: 16 }} />}
      </Screen>
    );
  }

  return (
    <Screen tabBar={false} scroll={false}>
      <FlatList
        data={d.visible && hiddenAction !== 'retry' ? d.people : []}
        keyExtractor={(x) => x.person.user_id}
        renderItem={({ item }) => <PersonRow item={item} />}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        ListHeaderComponent={<View style={{ marginBottom: 14 }}>{head}</View>}
        ListEmptyComponent={
          hiddenAction === 'retry' ? (
            <EmptyNote icon="shield-alert-outline" title="Can’t show shared zones right now" body={d.hidden_reason ?? undefined} action="Retry" onAction={r.reload} />
          ) : !d.visible ? (
            <EmptyNote
              icon="eye-off-outline"
              title="Hidden for now"
              body={d.hidden_reason ?? 'Shared zones are hidden by your visibility settings.'}
              action={hiddenAction === 'settings' ? 'Settings' : undefined}
              onAction={() => router.push('/active')}
            />
          ) : (
            <EmptyNote icon="map-marker-question-outline" title="No shared zones yet" body="Keep moving. Your paths might cross." action="Start a walk" onAction={() => router.push({ pathname: '/run', params: { type: 'walk' } })} />
          )
        }
        ListFooterComponent={
          <View style={styles.privacy}>
            <Icon name="shield-lock-outline" size={15} color={colors.dim} />
            <Text style={styles.privacyText}>{PRIVACY_LINE}</Text>
          </View>
        }
        contentContainerStyle={{ paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
        initialNumToRender={12}
        windowSize={7}
        removeClippedSubviews
      />
    </Screen>
  );
}

function PersonRow({ item }: { item: SharedZonesPerson }) {
  const p = item.person;
  return (
    <PressScale onPress={() => router.push({ pathname: '/shared/[id]', params: { id: p.user_id } })} style={styles.row} scaleTo={0.985} accessibilityRole="button" accessibilityLabel={`${p.display_name}, ${item.shared_zones_count} shared zones`}>
      <PersonAvatar person={p} size={44} link={false} />
      <View style={{ flex: 1 }}>
        <Text style={styles.name} numberOfLines={1}>{p.display_name}</Text>
        <Text style={styles.meta} numberOfLines={1}>{item.top_zone ? `${item.top_zone.zone_name}${item.shared_zones_count > 1 ? ` + ${item.shared_zones_count - 1} more` : ''}` : 'Shared ground'}</Text>
      </View>
      <View style={styles.badge}>
        <Text style={styles.badgeV}>{item.shared_zones_count}</Text>
        <Text style={styles.badgeL}>{item.shared_zones_count === 1 ? 'zone' : 'zones'}</Text>
      </View>
    </PressScale>
  );
}

const styles = StyleSheet.create({
  sub: { color: colors.dim, fontFamily: fonts.regular, fontSize: 14, marginTop: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 12 },
  name: { color: colors.text, fontFamily: fonts.bold, fontSize: 15 },
  meta: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, marginTop: 2 },
  badge: { alignItems: 'center', minWidth: 48 },
  badgeV: { color: colors.primary, fontFamily: fonts.display, fontSize: 24, lineHeight: 26 },
  badgeL: { color: colors.dim, fontFamily: fonts.label, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' },
  privacy: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 16, paddingHorizontal: 4 },
  privacyText: { flex: 1, color: colors.dim, fontFamily: fonts.regular, fontSize: 12, lineHeight: 17 },
});
