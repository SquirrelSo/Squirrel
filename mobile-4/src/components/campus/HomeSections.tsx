/** Campus sections for Home, each self-contained with its own loading / error / empty state. */
import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { campusApi, CAMPUS_SOURCE, type ActiveNow, type ChallengeInvite, type SquirrelBoard } from '@/api/campus';
import { hiddenActionFor } from '@/api/campus/campusShapes';
import { EventRow } from '@/components/campus/EventRow';
import { isStudyBreak, StudyBreakCard } from '@/components/events/StudyBreak';
import { PersonAvatar } from '@/components/campus/PersonAvatar';
import { EmptyNote, ErrorState, LoadingRows } from '@/components/campus/States';
import { relationOf, UNDER_ATTACK } from '@/components/campus/territoryUi';
import { Card, Display, Icon, PressScale, Pulse, RowSub, RowTitle, SectionHeader } from '@/components/ui';
import { useCampus, useMe, useRealtime, useRefreshOnFocus, useTerritorySync, useZones } from '@/hooks/useCampus';
import { useAllTerritories } from '@/state/territoryStore';
import { alpha, colors, fonts, radius } from '@/theme';

/** Shown instead of the campus sections when there's no campus backend at all. */
export function CampusNotLive() {
  if (CAMPUS_SOURCE !== 'off') return null;
  return (
    <Card style={{ marginTop: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Icon name="map-marker-radius" size={26} color={colors.dim} />
      <View style={{ flex: 1 }}>
        <RowTitle>Campus map & territory</RowTitle>
        <RowSub>Switches on when the campus backend goes live.</RowSub>
      </View>
    </Card>
  );
}

export function CampusTerritoryCard() {
  const me = useMe();
  const zones = useZones();
  const sync = useTerritorySync();
  const all = useAllTerritories();
  const meId = me.data?.user_id ?? null;
  const stats = useMemo(() => {
    const mine = all.filter((t) => relationOf(t, meId) === 'mine');
    return { mine, attacked: mine.filter((t) => t.under_challenge), held: all.filter((t) => t.owner).length };
  }, [all, meId]);
  const names = new Map((zones.data ?? []).map((z) => [z.id, z.short_name ?? z.name]));
  const first = stats.attacked[0] ?? stats.mine[0];
  const attacked = stats.attacked.length > 0;
  if (sync.error && !all.length) return <ErrorState cause={sync.error} onRetry={sync.reload} compact title="Territory didn’t load" />;
  return (
    <PressScale onPress={() => router.push('/explore')} scaleTo={0.98}>
      <View style={[styles.zone, attacked && { borderColor: UNDER_ATTACK, shadowColor: UNDER_ATTACK }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.zoneKicker, attacked && { color: UNDER_ATTACK }]}>{attacked ? 'UNDER ATTACK' : stats.mine.length ? 'YOUR TERRITORY' : 'NO TERRITORY YET'}</Text>
          <Display size={26} numberOfLines={1}>{first ? names.get(first.zone_id) ?? 'Your zone' : 'Claim your first zone'}</Display>
          <Text style={styles.zoneInfo}>
            {sync.loading && !all.length
              ? 'Loading territory…'
              : `${stats.mine.length} zone${stats.mine.length === 1 ? '' : 's'} yours · ${stats.held}/${zones.data?.length ?? '—'} held on campus${attacked ? ` · ${stats.attacked.length} need defending` : ''}`}
          </Text>
        </View>
        <Icon name={attacked ? 'shield-alert' : 'chevron-right'} size={24} color={attacked ? UNDER_ATTACK : colors.primary} />
      </View>
    </PressScale>
  );
}

export function ActiveNowStrip() {
  const r = useCampus<ActiveNow>('active', () => campusApi.activeNow());
  useRefreshOnFocus(r.reload, 60_000);
  useRealtime((m) => {
    if (m.type === 'active.updated' && r.data) r.mutate({ ...r.data, active_now: m.data.active_now });
  });
  if (r.signedOut || (r.error && !r.data)) return null; // optional section: hide rather than nag
  const d = r.data;
  const faces = d ? [...d.active, ...d.nearby].filter((a, i, arr) => arr.findIndex((x) => x.person.user_id === a.person.user_id) === i).slice(0, 5) : [];
  // Why the lists are hidden / empty: Retry when the block list couldn't be checked (lists come back
  // empty, fail-closed), Settings (Open to Meet, on /active) when you're not visible yourself.
  const hiddenAction = d && !d.nearby.length ? hiddenActionFor(d.hidden_code) : null;
  const sub = hiddenAction && d?.hidden_reason ? d.hidden_reason : d?.nearby.length ? `${d.nearby.length} squirrels near you` : 'See who’s moving on campus';
  return (
    <PressScale onPress={() => router.push('/active')} scaleTo={0.98} style={styles.active} accessibilityLabel={d ? `${d.active_now} active now` : 'Active now'}>
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colors.green }}>
        <Pulse size={10} color={colors.green} />
      </View>
      <View style={{ flex: 1 }}>
        <RowTitle>{d ? `${d.active_now} active now` : 'Active now'}</RowTitle>
        <RowSub>{sub}</RowSub>
      </View>
      {hiddenAction && (
        <Pressable
          onPress={hiddenAction === 'retry' ? r.reload : () => router.push('/active')}
          style={styles.activeAction}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={hiddenAction === 'retry' ? 'Retry active now' : 'Open to Meet settings'}>
          <Text style={styles.activeActionText}>{hiddenAction === 'retry' ? 'Retry' : 'Settings'}</Text>
        </Pressable>
      )}
      <View style={{ flexDirection: 'row' }}>
        {faces.map((a, i) => (
          <View key={a.person.user_id} style={{ marginLeft: i ? -10 : 0, borderRadius: 20, borderWidth: 2, borderColor: colors.card }}>
            <PersonAvatar person={a.person} size={30} link={false} />
          </View>
        ))}
      </View>
      <Icon name="chevron-right" size={20} color={colors.dim} />
    </PressScale>
  );
}

export function SocialShortcuts() {
  const inv = useCampus<ChallengeInvite[]>('invites:incoming', () => campusApi.invites('incoming'));
  useRealtime((m) => {
    if (m.type === 'invite.updated') inv.reload();
  });
  const pending = (inv.data ?? []).filter((i) => i.status === 'pending').length;
  return (
    <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
      <Shortcut icon="account-heart" label="Friend Mode" sub="People who move like you" color={colors.primary} onPress={() => router.push('/friends')} />
      <Shortcut icon="sword-cross" label="Challenges" sub={pending ? `${pending} waiting on you` : 'Invite a rival'} color={colors.secondary} badge={pending} onPress={() => router.push('/invites')} />
    </View>
  );
}

function Shortcut({ icon, label, sub, color, onPress, badge }: { icon: React.ComponentProps<typeof Icon>['name']; label: string; sub: string; color: string; onPress: () => void; badge?: number }) {
  return (
    <Pressable onPress={onPress} style={[styles.short, { borderColor: `${color}66` }]} accessibilityRole="button" accessibilityLabel={`${label}. ${sub}`}>
      <Icon name={icon} size={22} color={color} />
      <Text style={[styles.shortTitle, { color }]}>{label}</Text>
      <Text style={styles.shortSub} numberOfLines={1}>{sub}</Text>
      {!!badge && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge}</Text>
        </View>
      )}
    </Pressable>
  );
}

export function HomeLeaderboard({ campusName }: { campusName: string }) {
  const r = useCampus<SquirrelBoard>('board:squirrels:daily:home', () => campusApi.squirrelBoard('daily', 5));
  useRefreshOnFocus(r.reload);
  return (
    <>
      <SectionHeader kicker={`03 — ${campusName}`} title="Today’s Top Squirrels" action="All boards" onAction={() => router.push('/leaderboard')} />
      {r.signedOut ? (
        <EmptyNote icon="trophy-outline" title="Sign in to see the board" action="Sign in" onAction={() => router.push('/sign-in')} />
      ) : r.error && !r.data ? (
        <ErrorState cause={r.cause} onRetry={r.reload} compact />
      ) : !r.data ? (
        <LoadingRows rows={3} height={48} />
      ) : !r.data.entries.length ? (
        <EmptyNote icon="trophy-outline" title="Nobody on the board yet today" />
      ) : (
        <Card style={{ paddingVertical: 6 }}>
          {r.data.entries.slice(0, 4).map((e, i) => {
            const me = e.user_id === r.data!.me?.user_id;
            return (
              <View key={e.user_id} style={[styles.leader, me && styles.leaderMe, i > 0 && !me && { borderTopWidth: 1, borderTopColor: colors.line }]}>
                <Text style={[styles.rank, i === 0 && { color: colors.primary }]}>{String(e.rank).padStart(2, '0')}</Text>
                <PersonAvatar person={e} size={34} ring={i === 0 ? colors.primary : undefined} />
                <View style={{ flex: 1, marginLeft: 10 }}>
                  <Text style={styles.leaderName}>{me ? 'You' : e.display_name}</Text>
                  <Text style={styles.leaderSub}>{[e.hostel, `${e.zones_claimed} zones`].filter(Boolean).join(' · ')}</Text>
                </View>
                <Text style={styles.leaderXp}>{e.xp.toLocaleString('en-IN')} XP</Text>
              </View>
            );
          })}
        </Card>
      )}
    </>
  );
}

export function HomeEvents() {
  const r = useCampus('events:upcoming', () => campusApi.events({ scope: 'upcoming' }));
  useRefreshOnFocus(r.reload);
  const nextBreak = r.data?.items.find(isStudyBreak) ?? null;
  return (
    <>
      <SectionHeader kicker="04 — Meetups" title="Happening on campus" action="All events" onAction={() => router.push('/events')} />
      {r.signedOut ? null : r.error && !r.data ? (
        <ErrorState cause={r.cause} onRetry={r.reload} compact />
      ) : !r.data ? (
        <LoadingRows rows={2} height={80} />
      ) : !r.data.items.length ? (
        <EmptyNote icon="calendar-blank-outline" title="Nothing scheduled yet" />
      ) : (
        <View style={{ gap: 10 }}>
          {/* A quick campus reset leads when there's one coming up */}
          {nextBreak && <StudyBreakCard event={nextBreak} />}
          {r.data.items
            .filter((e) => e.id !== nextBreak?.id)
            .slice(0, nextBreak ? 2 : 3)
            .map((e) => (
              <EventRow key={e.id} event={e} />
            ))}
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  zone: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 2, borderColor: colors.primary, padding: 14, transform: [{ rotate: '-0.6deg' }], shadowColor: colors.primary, shadowOpacity: 0.25, shadowRadius: 14, shadowOffset: { width: 0, height: 0 } },
  zoneKicker: { color: colors.primary, fontFamily: fonts.monoBold, fontSize: 10, letterSpacing: 1.4 },
  zoneInfo: { color: colors.dim, fontFamily: fonts.mono, fontSize: 10, marginTop: 6 },
  active: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 14, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: alpha(colors.green, 0.35), padding: 12 },
  activeAction: { borderWidth: 1, borderColor: colors.lineHi, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 5 },
  activeActionText: { color: colors.primary, fontFamily: fonts.label, fontSize: 12, letterSpacing: 0.6, textTransform: 'uppercase' },
  short: { flex: 1, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, padding: 12, gap: 2 },
  shortTitle: { fontFamily: fonts.labelBold, fontSize: 16, letterSpacing: 0.8, textTransform: 'uppercase', marginTop: 4 },
  shortSub: { color: colors.dim, fontFamily: fonts.regular, fontSize: 11 },
  badge: { position: 'absolute', top: 8, right: 8, minWidth: 20, height: 20, borderRadius: 10, backgroundColor: colors.secondary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  badgeText: { color: colors.onSecondary, fontFamily: fonts.bold, fontSize: 11 },
  leader: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 4 },
  leaderMe: { backgroundColor: alpha(colors.primary, 0.08), borderRadius: radius.md, marginHorizontal: -6, paddingHorizontal: 10 },
  rank: { color: colors.dim, fontFamily: fonts.display, fontSize: 18, width: 34 },
  leaderName: { color: colors.text, fontFamily: fonts.bold, fontSize: 14 },
  leaderSub: { color: colors.dim, fontFamily: fonts.regular, fontSize: 11 },
  leaderXp: { color: colors.gold, fontFamily: fonts.bold, fontSize: 13 },
});
