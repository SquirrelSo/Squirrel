/** CREW PROFILE — members, crew territories, battles, upcoming events, join / leave. */
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Scene } from '@/art/Scene';
import { campusApi, type CrewDetail } from '@/api/campus';
import { BattleList } from '@/components/campus/BattleList';
import { CrewJoinButton } from '@/components/campus/CrewJoin';
import { EventRow } from '@/components/campus/EventRow';
import { PersonAvatar } from '@/components/campus/PersonAvatar';
import { ErrorState, LoadingRows, SourceBadge } from '@/components/campus/States';
import { shortTime } from '@/components/campus/territoryUi';
import { Display, Icon, IconButton, PressScale, Scrim, SectionHeader, Tag } from '@/components/ui';
import { useCampus } from '@/hooks/useCampus';
import { colors, fonts, MAX_WIDTH, radius } from '@/theme';
import { SoonPill } from '@/components/Locked';
import { isLocked } from '@/data/features';

export default function CrewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const r = useCampus<CrewDetail>(`crew:${id}`, () => campusApi.crew(id));
  const crew = r.data;
  const back = () => (router.canGoBack() ? router.back() : router.replace('/crews'));

  if (!crew) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top + 10, paddingHorizontal: 16 }}>
        <IconButton icon="chevron-left" size={26} onPress={back} label="Back" />
        <View style={{ marginTop: 16 }}>{r.error ? <ErrorState cause={r.cause} onRetry={r.reload} /> : <LoadingRows rows={4} height={80} />}</View>
      </View>
    );
  }
  const c = crew.color ?? colors.primary;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: insets.bottom + 30 }}>
      <View style={{ height: 230 + insets.top }}>
        <Scene kind="run" seed={crew.name.length} aspect={Math.min(width, MAX_WIDTH) / (230 + insets.top)} style={StyleSheet.absoluteFill} />
        <Scrim strong />
        <View style={[styles.top, { top: insets.top + 8 }]}>
          <IconButton icon="chevron-left" size={26} onPress={back} label="Back" />
          <SourceBadge />
        </View>
        <View style={styles.heroText}>
          <View style={[styles.badge, { backgroundColor: c }]}>
            <Icon name={(crew.icon as React.ComponentProps<typeof Icon>['name']) ?? 'account-group'} size={28} color={colors.onPrimary} />
          </View>
          <Display size={34} color={colors.onImage} style={{ marginTop: 10 }}>{crew.name}</Display>
          {!!crew.description && <Text style={styles.sub}>{crew.description}</Text>}
        </View>
      </View>
      <View style={styles.col}>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Tag label={`${crew.members_count} members`} icon="account-group" color={colors.secondary} />
          <Tag label={`${crew.territories_count} zones`} icon="flag-variant" />
          {!!crew.meets && <Tag label={crew.meets} icon="calendar-clock" color={colors.green} />}
        </View>
        <View style={{ marginTop: 16 }}>
          <CrewJoinButton crew={crew} onChanged={() => r.reload()} />
        </View>

        <BattleList crewId={crew.id} newBattle={crew.my_membership == null ? { label: 'Challenge this crew', params: { crewId: crew.id } } : undefined} />

        <SectionHeader title="Members" />
        {crew.members.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 14 }}>
            {crew.members.map((m) => (
              <View key={m.user_id} style={{ alignItems: 'center', width: 64 }}>
                <PersonAvatar person={m} size={54} />
                <Text style={styles.member} numberOfLines={1}>{m.display_name.split(' ')[0]}</Text>
              </View>
            ))}
          </ScrollView>
        ) : (
          <Text style={styles.empty}>No members yet.</Text>
        )}

        <SectionHeader title="Crew territory" />
        {crew.territories.length ? (
          <View style={{ gap: 8 }}>
            {crew.territories.map((t) => (
              <PressScale key={t.zone_id} onPress={() => router.push({ pathname: '/zone/[id]', params: { id: t.zone_id } })} style={styles.row} scaleTo={0.98}>
                <View style={[styles.dot, { backgroundColor: c }]} />
                <Text style={styles.rowTitle}>{t.zone_name}</Text>
                <Text style={styles.meta}>since {shortTime(t.claimed_at)}</Text>
              </PressScale>
            ))}
          </View>
        ) : (
          <Text style={styles.empty}>The crew doesn’t hold any zones right now.</Text>
        )}

        <SectionHeader title="Upcoming" />
        {isLocked('events') ? (
          <SoonPill />
        ) : crew.upcoming_events.length ? (
          <View style={{ gap: 10 }}>
            {crew.upcoming_events.map((e) => (
              <EventRow key={e.id} event={e} />
            ))}
          </View>
        ) : (
          <Text style={styles.empty}>No upcoming events.</Text>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  top: { position: 'absolute', left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  col: { paddingHorizontal: 16, width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center', marginTop: 14 },
  heroText: { position: 'absolute', left: 16, right: 16, bottom: 14 },
  badge: { width: 58, height: 58, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: 'rgba(255,255,255,0.2)' },
  sub: { color: colors.onImageSub, fontFamily: fonts.medium, fontSize: 14 },
  member: { color: colors.sub, fontFamily: fonts.medium, fontSize: 12, marginTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: 12 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  rowTitle: { flex: 1, color: colors.text, fontFamily: fonts.semibold, fontSize: 14 },
  meta: { color: colors.dim, fontFamily: fonts.mono, fontSize: 11 },
  empty: { color: colors.dim, fontFamily: fonts.regular, fontSize: 13 },
});
