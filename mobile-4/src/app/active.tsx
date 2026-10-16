/**
 * ACTIVE NOW + SQUIRRELS NEAR YOU. Only what the backend makes visible: coarse proximity
 * buckets ("very close", "nearby", "on campus"), never coordinates or anyone's zone.
 * Near You needs Open to Meet — you only see nearby people while you're visible too.
 * When the backend hid or emptied the lists (`hidden_code`, e.g. the block list couldn't be checked),
 * the screen says why with a Retry instead of looking like nobody's around.
 */
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { campusApi, type ActiveNow, type ActivePerson } from '@/api/campus';
import { hiddenActionFor } from '@/api/campus/campusShapes';
import { PersonAvatar } from '@/components/campus/PersonAvatar';
import { PokeButton } from '@/components/social/PokeButton';
import { ModeChip, OpenToMeetToggle, PROXIMITY_TEXT } from '@/components/campus/Social';
import { EmptyNote, ErrorState, LoadingRows, SignedOutState, SourceBadge } from '@/components/campus/States';
import { shortTime } from '@/components/campus/territoryUi';
import { Display, Header, Icon, Kicker, PressScale, Pulse, Screen, SectionHeader } from '@/components/ui';
import { useCampus, useMe, useRealtime, useRefreshOnFocus } from '@/hooks/useCampus';
import { alpha, colors, fonts, radius } from '@/theme';

const ACT_ICON: Record<string, React.ComponentProps<typeof Icon>['name']> = { run: 'run-fast', walk: 'walk', workout: 'arm-flex', event: 'calendar-star' };

export default function Active() {
  const me = useMe();
  const r = useCampus<ActiveNow>('active', () => campusApi.activeNow());
  useRefreshOnFocus(r.reload, 30_000);
  useRealtime((m) => {
    if (m.type === 'active.updated' && r.data) r.mutate({ ...r.data, active_now: m.data.active_now });
  });
  const d = r.data;
  // Fail-closed lists (block list unchecked, or a reason this app doesn't know): both lists are empty.
  const retryReason = d && hiddenActionFor(d.hidden_code) === 'retry' ? d.hidden_reason : null;
  const openToMeetOff = (me.data && !me.data.open_to_meet) || d?.hidden_code === 'open_to_meet_off';
  return (
    <Screen tabBar={false}>
      <Header back title="" right={<SourceBadge />} />
      <Kicker>Right now</Kicker>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 }}>
        <Display size={40}>Active <Text style={{ color: colors.primary }}>now</Text></Display>
        {d && (
          <View style={styles.count}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.green }}>
              <Pulse size={8} color={colors.green} />
            </View>
            <Text style={styles.countText}>{d.active_now}</Text>
          </View>
        )}
      </View>

      {me.data && (
        <View style={{ marginTop: 12 }}>
          <OpenToMeetToggle value={me.data.open_to_meet} onChange={() => r.reload()} />
        </View>
      )}

      {r.signedOut ? (
        <SignedOutState what="who's active" />
      ) : r.error && !d ? (
        <ErrorState cause={r.cause} onRetry={r.reload} />
      ) : !d ? (
        <LoadingRows rows={4} height={72} style={{ marginTop: 12 }} />
      ) : retryReason ? (
        <>
          <SectionHeader title="Moving now" />
          <EmptyNote icon="shield-alert-outline" title="Can’t show people right now" body={retryReason} action="Retry" onAction={r.reload} />
          <Text style={styles.fine}>Updated {shortTime(d.as_of)} · nobody is shown until this check works.</Text>
        </>
      ) : (
        <>
          <SectionHeader title="Moving now" />
          {d.active.length ? <View style={{ gap: 8 }}>{d.active.map((a) => <PersonRow key={a.person.user_id} a={a} />)}</View> : <EmptyNote icon="sleep" title="Quiet right now" body="Nobody visible is out moving. Be the first — start a run." action="Start a run" onAction={() => router.push('/run')} />}

          <SectionHeader title="Squirrels near you" />
          {openToMeetOff ? (
            <EmptyNote icon="hand-back-left-off-outline" title="Turn on Open to Meet" body="Use the switch above: nearby people are only shown while you’re visible too. Only rough distance is ever shared." />
          ) : d.nearby.length ? (
            <View style={{ gap: 8 }}>{d.nearby.map((a) => <PersonRow key={a.person.user_id} a={a} />)}</View>
          ) : (
            <EmptyNote icon="map-marker-radius-outline" title="No one nearby" body="No one who’s open to meet is close to you right now." />
          )}
          <Text style={styles.fine}>Updated {shortTime(d.as_of)} · exact locations are never shown.</Text>
        </>
      )}
    </Screen>
  );
}

function PersonRow({ a }: { a: ActivePerson }) {
  const p = a.person;
  const shared = [...p.shared.shared_zones.map((z) => z.zone_name), ...p.shared.shared_crews.map((c) => c.name)].slice(0, 2);
  return (
    <PressScale onPress={() => router.push({ pathname: '/user/[id]', params: { id: p.user_id } })} style={styles.row} scaleTo={0.985} accessibilityLabel={`${p.display_name}${a.proximity ? `, ${PROXIMITY_TEXT[a.proximity]}` : ''}`}>
      <View>
        <PersonAvatar person={p} size={46} link={false} ring={a.activity ? colors.green : undefined} />
        {a.activity && (
          <View style={styles.actBadge}>
            <Icon name={ACT_ICON[a.activity.type] ?? 'run-fast'} size={11} color={colors.onPrimary} />
          </View>
        )}
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={styles.name} numberOfLines={1}>{p.display_name}</Text>
          <ModeChip mode={p.connection_mode} />
        </View>
        <Text style={styles.meta} numberOfLines={1}>
          {a.activity ? `${a.activity.type} · started ${shortTime(a.activity.started_at)}` : 'Not moving right now'}
          {shared.length ? ` · shared: ${shared.join(', ')}` : ''}
        </Text>
        {a.proximity && <Text style={[styles.meta, { color: colors.primary }]}>{PROXIMITY_TEXT[a.proximity]}</Text>}
      </View>
      <PokeButton user={p} size="sm" />
    </PressScale>
  );
}

const styles = StyleSheet.create({
  count: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  countText: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 18 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 12 },
  actBadge: { position: 'absolute', right: -3, bottom: -3, width: 20, height: 20, borderRadius: 10, backgroundColor: colors.green, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.card },
  name: { color: colors.text, fontFamily: fonts.bold, fontSize: 15, flexShrink: 1 },
  meta: { color: colors.dim, fontFamily: fonts.mono, fontSize: 11, marginTop: 2 },
  prox: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderColor: alpha(colors.primary, 0.4), borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3 },
  proxText: { color: colors.primary, fontFamily: fonts.label, fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase' },
  fine: { color: colors.mute, fontFamily: fonts.mono, fontSize: 10, textAlign: 'center', marginTop: 16 },
});
