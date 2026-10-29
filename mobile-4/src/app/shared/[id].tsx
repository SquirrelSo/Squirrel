/**
 * SHARED ZONES with one person — "You've both been here." Zone-level overlap from the backend
 * (GET /v1/users/{id}/context). No routes, no times, no live location — and the copy says so.
 */
import { StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { campusApi, type Profile, type SharedContext } from '@/api/campus';
import { hiddenActionFor } from '@/api/campus/campusShapes';
import { PersonAvatar } from '@/components/campus/PersonAvatar';
import { EmptyNote, ErrorState, LoadingRows, SourceBadge } from '@/components/campus/States';
import { PRIVACY_LINE, SharedZoneRow } from '@/components/discovery/SharedZones';
import { PokeButton } from '@/components/social/PokeButton';
import { Button, Card, Display, Header, Icon, Kicker, Screen } from '@/components/ui';
import { useCampus, useMe } from '@/hooks/useCampus';
import { colors, fonts, radius } from '@/theme';

export default function SharedWith() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const me = useMe();
  // Same cache keys as the profile screen, so arriving from a profile is instant.
  const other = useCampus<Profile>(`profile:${id}`, () => campusApi.profile(id));
  const ctx = useCampus<SharedContext>(`context:${id}`, () => campusApi.sharedContext(id));
  const zones = ctx.data?.shared_zones ?? [];
  // Emptied because the server couldn't check (not "nothing shared"): say so and offer a retry.
  const unchecked = hiddenActionFor(ctx.data?.hidden_code) === 'retry';
  const p = other.data;
  const first = p?.display_name.split(' ')[0] ?? 'them';

  return (
    <Screen tabBar={false}>
      <Header back title="" right={<SourceBadge />} />
      <Kicker color={colors.secondary}>Shared zones</Kicker>
      <Display size={38} style={{ marginTop: 4 }}>
        You’ve both{'\n'}
        <Text style={{ color: colors.primary }}>been here.</Text>
      </Display>

      {/* You ↔ them */}
      <View style={styles.pair}>
        <View style={styles.side}>
          {me.data ? <PersonAvatar person={me.data} size={54} link={false} ring={colors.primary} /> : <View style={styles.ph} />}
          <Text style={styles.who}>You</Text>
        </View>
        <View style={styles.link}>
          <Text style={styles.count} accessibilityLabel={`${zones.length} shared zones`}>{ctx.data && !unchecked ? zones.length : '–'}</Text>
          <Text style={styles.countL}>{zones.length === 1 ? 'zone' : 'zones'}</Text>
        </View>
        <View style={styles.side}>
          {p ? <PersonAvatar person={p} size={54} ring={colors.secondary} /> : <View style={styles.ph} />}
          <Text style={styles.who} numberOfLines={1}>{p?.display_name ?? '…'}</Text>
        </View>
      </View>

      {ctx.error && !ctx.data ? (
        <ErrorState cause={ctx.cause} onRetry={ctx.reload} feature="Shared zones" />
      ) : !ctx.data ? (
        <LoadingRows rows={3} height={72} style={{ marginTop: 16 }} />
      ) : unchecked ? (
        <EmptyNote icon="shield-alert-outline" title="Can’t check shared zones right now" body={ctx.data.hidden_reason ?? undefined} action="Retry" onAction={ctx.reload} />
      ) : zones.length === 0 ? (
        <Card style={styles.empty}>
          <Icon name="map-marker-question-outline" size={30} color={colors.dim} />
          <Display size={22} style={{ textAlign: 'center' }}>No common ground… yet.</Display>
          <Text style={styles.body}>Keep moving. Your paths might cross.</Text>
          <Button label="Start a walk" size="sm" variant="secondary" iconLeft="walk" onPress={() => router.push({ pathname: '/run', params: { type: 'walk' } })} style={{ marginTop: 8 }} />
        </Card>
      ) : (
        <View style={{ gap: 8, marginTop: 16 }}>
          {zones.map((z, i) => (
            <SharedZoneRow key={z.zone_id} zone={z} index={i} />
          ))}
        </View>
      )}

      <View style={styles.privacy} accessibilityRole="text">
        <Icon name="shield-lock-outline" size={15} color={colors.dim} />
        <Text style={styles.privacyText}>{PRIVACY_LINE}</Text>
      </View>

      {/* Discover → connect: the next step is right here */}
      {p && zones.length > 0 && (
        <View style={styles.actions}>
          <PokeButton user={p} style={{ flex: 1 }} />
          <Button label={`Challenge ${first}`} variant="secondary" size="md" iconLeft="sword-cross" onPress={() => router.push({ pathname: '/invite/new', params: { userId: p.user_id, zoneId: zones[0].zone_id } })} style={{ flex: 1 }} />
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  pair: { flexDirection: 'row', alignItems: 'center', marginTop: 18, backgroundColor: colors.card, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.line, paddingVertical: 16, paddingHorizontal: 12 },
  side: { flex: 1, alignItems: 'center', gap: 6 },
  ph: { width: 54, height: 54, borderRadius: 27, backgroundColor: colors.cardHi },
  who: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 14, letterSpacing: 0.8, textTransform: 'uppercase', maxWidth: 120 },
  link: { alignItems: 'center', paddingHorizontal: 8 },
  count: { color: colors.primary, fontFamily: fonts.display, fontSize: 40, lineHeight: 44 },
  countL: { color: colors.dim, fontFamily: fonts.label, fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase' },
  empty: { marginTop: 16, alignItems: 'center', gap: 8, paddingVertical: 22 },
  body: { color: colors.dim, fontFamily: fonts.regular, fontSize: 14, textAlign: 'center' },
  privacy: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 16, paddingHorizontal: 4 },
  privacyText: { flex: 1, color: colors.dim, fontFamily: fonts.regular, fontSize: 12, lineHeight: 17 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 16 },
});
