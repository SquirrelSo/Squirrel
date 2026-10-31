/**
 * Profile (yours or someone else's), entirely from the backend profile. Sections render only
 * when their data exists, so new/removed backend fields don't break the layout.
 */
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Scene } from '@/art/Scene';
import { campusApi, errorText, featureUnavailable, type BlockState, type Me, type Profile, type SharedContext } from '@/api/campus';
import { hiddenActionFor } from '@/api/campus/campusShapes';
import { useAuth } from '@/auth/AuthProvider';
import { PersonAvatar } from '@/components/campus/PersonAvatar';
import { PokeButton } from '@/components/social/PokeButton';
import { ThemeToggle } from '@/components/ThemeToggle';
import { ProfileDateSuggestion } from '@/components/social/SquirrelDates';
import { SharedZonesEntry } from '@/components/discovery/SharedZones';
import { getAmbassador } from '@/api/campus/community';
import type { AmbassadorState } from '@/api/campus/types';
import { BadgeRow, Icebreakers, ModeChip, OpenToMeetToggle } from '@/components/campus/Social';
import { ErrorState, LoadingRows, SignedOutState, SourceBadge } from '@/components/campus/States';
import { km, shortTime } from '@/components/campus/territoryUi';
import { Button, Card, Display, Icon, IconButton, PressScale, Scrim, SectionHeader, TAB_BAR_SPACE, tap } from '@/components/ui';
import { invalidateCampus, useAction, useCampus, useMe, useRefreshOnFocus } from '@/hooks/useCampus';
import { useApp } from '@/state/AppState';
import { colors, fonts, MAX_WIDTH, radius } from '@/theme';

export function CampusProfileView({ userId, isMe }: { userId?: string; isMe: boolean }) {
  const mine = useMe();
  const other = useCampus<Profile>(`profile:${userId}`, () => campusApi.profile(userId!), { enabled: !isMe && !!userId });
  const ctx = useCampus<SharedContext>(`context:${userId}`, () => campusApi.sharedContext(userId!), { enabled: !isMe && !!userId });
  const r = isMe ? mine : other;
  const amb = useCampus<AmbassadorState>('ambassador', () => getAmbassador(), { enabled: isMe });
  // Cheap and user-visible: re-read on every return, so a fresh application shows at once.
  useRefreshOnFocus(amb.reload, 0);
  const ambStatus = amb.data?.application?.status;
  const ambUnavailable = !amb.data && !!amb.error && featureUnavailable(amb.cause);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { signOut } = useAuth();
  const colW = Math.min(width, MAX_WIDTH);
  const p = r.data as (Profile & Partial<Me>) | undefined;

  const back = () => (router.canGoBack() ? router.back() : router.replace('/home'));
  if (!p) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top + 10, paddingHorizontal: 16 }}>
        {!isMe && <IconButton icon="chevron-left" size={26} onPress={back} label="Back" />}
        <View style={{ marginTop: 16, width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center' }}>
          {r.signedOut ? <SignedOutState what="your profile" /> : r.error ? <ErrorState cause={r.cause} onRetry={r.reload} /> : <LoadingRows rows={4} height={90} />}
        </View>
      </View>
    );
  }
  const s = p.stats;
  const v = p.verification;
  const shared = ctx.data;
  // A private account you don't follow: the server withheld everything but the name and avatar.
  const priv = !isMe && p.restricted === true;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: (isMe ? TAB_BAR_SPACE : 30) + insets.bottom }} showsVerticalScrollIndicator={false}>
      <View style={{ height: 170 + insets.top }}>
        <Scene kind={isMe ? 'city-sunset' : 'city-night'} seed={p.user_id.length * 3} aspect={colW / (170 + insets.top)} style={StyleSheet.absoluteFill} />
        <Scrim />
        <View style={[styles.topBar, { top: insets.top + 8 }]}>
          {isMe ? <SourceBadge /> : <IconButton icon="chevron-left" size={26} onPress={back} label="Back" />}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {isMe && <IconButton icon="bell-outline" onPress={() => router.push('/invites')} label="Challenge invites" />}
            {isMe && <IconButton icon="pencil-outline" onPress={() => router.push('/edit-profile')} label="Edit profile" />}
          </View>
        </View>
      </View>

      <View style={styles.col}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', marginTop: -52, gap: 12 }}>
          <PersonAvatar person={p} size={104} ring={colors.primary} link={false} />
          <View style={{ flex: 1, paddingBottom: 6, gap: 6 }}>
            {!priv && (
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                <ModeChip mode={p.connection_mode} />
                {p.founding_member && (
                  <View style={[styles.pill, { borderColor: colors.primary }]}>
                    <Icon name="star-four-points" size={11} color={colors.primary} />
                    <Text style={[styles.pillText, { color: colors.primary }]}>Founding Squirrel</Text>
                  </View>
                )}
                <View style={[styles.pill, { borderColor: p.open_to_meet ? colors.green : colors.lineHi }]}>
                  <Icon name={p.open_to_meet ? 'hand-wave' : 'hand-back-left-off-outline'} size={11} color={p.open_to_meet ? colors.green : colors.dim} />
                  <Text style={[styles.pillText, { color: p.open_to_meet ? colors.green : colors.dim }]}>{p.open_to_meet ? 'Open to meet' : 'Not meeting now'}</Text>
                </View>
              </View>
            )}
          </View>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12 }}>
          <Display size={30} numberOfLines={1} style={{ flexShrink: 1 }}>{p.display_name}</Display>
          {v.student_verified && <Icon name="check-decagram" size={20} color={colors.secondary} accessibilityLabel="Verified student" />}
        </View>
        {!priv && <Text style={styles.meta}>{[p.hostel && `${p.hostel} Hostel`, `joined ${shortTime(p.joined_at)}`].filter(Boolean).join(' · ')}</Text>}
        {!priv && !!p.bio && <Text style={styles.bio}>{p.bio}</Text>}

        {!isMe && (
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
            <PokeButton user={p} style={{ flex: 1 }} />
            <Button label="Challenge" variant="secondary" size="md" iconLeft="sword-cross" onPress={() => router.push({ pathname: '/invite/new', params: { userId: p.user_id } })} style={{ flex: 1 }} />
          </View>
        )}

        {isMe && (
          <View style={{ marginTop: 14 }}>
            <OpenToMeetToggle value={p.open_to_meet} />
          </View>
        )}

        {priv ? (
          <Card style={styles.private}>
            <Icon name="lock-outline" size={26} color={colors.dim} />
            <Text style={styles.rowTitle}>Private account</Text>
            <Text style={styles.privateText}>{p.display_name.split(' ')[0]}’s activity, crews and badges are only visible to people they’ve accepted.</Text>
          </Card>
        ) : (
          <>
          {/* Shared context + icebreakers (others only; hidden when the backend has none) */}
          {!isMe && shared && (shared.shared_zones.length > 0 || shared.shared_crews.length > 0 || shared.icebreakers.length > 0) && (
            <Card style={{ marginTop: 14, gap: 10 }}>
              {shared.shared_zones.length > 0 && (
                <Text style={styles.sharedLine}>
                  <Icon name="map-marker-radius" size={13} color={colors.primary} /> Shared ground: {shared.shared_zones.map((z) => z.zone_name).join(', ')}
                </Text>
              )}
              {shared.shared_crews.length > 0 && (
                <Text style={styles.sharedLine}>
                  <Icon name="account-group" size={13} color={colors.blue} /> Both in {shared.shared_crews.map((c) => c.name).join(', ')}
                </Text>
              )}
              <Icebreakers items={shared.icebreakers} targetUserId={p.user_id} max={4} />
            </Card>
          )}

          {!isMe && userId && ctx.data && (
            <View style={{ marginTop: 10 }}>
              <SharedZonesEntry userId={userId} zones={ctx.data.shared_zones} unchecked={hiddenActionFor(ctx.data.hidden_code) === 'retry'} />
            </View>
          )}
          {!isMe && userId && <ProfileDateSuggestion userId={userId} />}

          {/* Stats */}
          <SectionHeader title="Activity stats" />
          <View style={styles.grid}>
            {s.total_distance_m != null && <StatTile icon="map-marker-distance" v={km(s.total_distance_m)} l="Total distance" />}
            <StatTile icon="calendar-month" v={km(s.month_distance_m)} l="This month" />
            {s.zones_claimed != null && <StatTile icon="flag-variant" v={String(s.zones_claimed)} l="Zones held" c={colors.primary} />}
            {s.territories_defended != null && <StatTile icon="shield-check" v={String(s.territories_defended)} l="Defended" c={colors.gold} />}
            {s.territories_stolen != null && <StatTile icon="sword-cross" v={String(s.territories_stolen)} l="Stolen" c={colors.secondary} />}
            <StatTile icon="account-group" v={String(s.crew_memberships)} l="Crews" c={colors.blue} />
            {s.events_attended != null && <StatTile icon="calendar-check" v={String(s.events_attended)} l="Events" c={colors.violet} />}
            {s.streak_days != null && <StatTile icon="fire" v={`${s.streak_days}d`} l="Streak" c={colors.orange} />}
          </View>

          {/* Territory */}
          <SectionHeader title="Territory" action={isMe ? 'Map' : undefined} onAction={isMe ? () => router.push('/explore') : undefined} />
          {p.territories.length ? (
            <View style={{ gap: 8 }}>
              {p.territories.map((t) => (
                <PressScale key={t.zone_id} onPress={() => router.push({ pathname: '/zone/[id]', params: { id: t.zone_id } })} style={styles.row} scaleTo={0.98} accessibilityLabel={`${t.zone_name}, held`}>
                  <View style={[styles.dot, { backgroundColor: isMe ? colors.primary : colors.secondary }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTitle}>{t.zone_name}</Text>
                    <Text style={styles.meta}>held since {shortTime(t.claimed_at)} · defended {t.defended_count}×</Text>
                  </View>
                  <Icon name="chevron-right" size={18} color={colors.dim} />
                </PressScale>
              ))}
            </View>
          ) : (
            <Text style={styles.empty}>{isMe ? 'No zones yet. Run through one, then claim it.' : 'Holds no zones right now.'}</Text>
          )}

          {/* Crews */}
          <SectionHeader title="Crews" action={isMe ? 'Find crews' : undefined} onAction={isMe ? () => router.push('/crews') : undefined} />
          {p.crews.length ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {p.crews.map((c) => (
                <PressScale key={c.id} onPress={() => router.push({ pathname: '/crew/[id]', params: { id: c.id } })} style={[styles.crew, { borderColor: c.color ?? colors.line }]} scaleTo={0.97}>
                  <Icon name={(c.icon as React.ComponentProps<typeof Icon>['name']) ?? 'account-group'} size={14} color={c.color ?? colors.text} />
                  <Text style={styles.crewText}>{c.name}</Text>
                  {c.role && c.role !== 'member' && <Text style={styles.role}>{c.role}</Text>}
                </PressScale>
              ))}
            </View>
          ) : (
            <Text style={styles.empty}>{isMe ? 'Not in a crew yet.' : 'No crews yet.'}</Text>
          )}

          {isMe && (
            <>
              <SectionHeader title="People & places" />
              <View style={{ gap: 8 }}>
                <LinkRow icon="account-heart-outline" label="Friends" onPress={() => router.push('/friends')} />
                <LinkRow icon="map-marker-radius" label="Shared zones" detail="Who’s been where you have" onPress={() => router.push('/shared')} />
                <LinkRow icon="shield-account-outline" label="Safety & visibility" detail={p.open_to_meet ? 'Open to Meet is on' : 'Open to Meet is off'} onPress={() => router.push('/active')} />
              </View>
            </>
          )}

          {/* Badges */}
          <SectionHeader title="Badges" action={isMe ? 'All badges' : undefined} onAction={isMe ? () => router.push('/badges') : undefined} />
          {p.badges.length ? <BadgeRow badges={p.badges} /> : <Text style={styles.empty}>No badges yet.</Text>}

          {/* Activity history */}
          {p.recent_activities.length > 0 && (
            <>
              <SectionHeader title="Recent activity" />
              <View style={{ gap: 8 }}>
                {p.recent_activities.map((a) => (
                  <View key={a.id} style={styles.row}>
                    <Icon name={a.type === 'walk' ? 'walk' : 'run-fast'} size={18} color={colors.primary} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle}>{km(a.distance_m, 2)} {a.type}</Text>
                      <Text style={styles.meta}>
                        {shortTime(a.started_at)} · {Math.round(a.duration_s / 60)} min · {a.zones_count} zone{a.zones_count === 1 ? '' : 's'}
                      </Text>
                    </View>
                    <Text style={[styles.status, { color: a.status === 'verified' ? colors.green : a.status === 'rejected' ? colors.coral : colors.gold }]}>{a.status}</Text>
                  </View>
                ))}
              </View>
            </>
          )}

          {/* Verification */}
          <SectionHeader title="Verification" />
          <Card style={{ gap: 8 }}>
            <Check ok={v.email_verified} label={v.email_domain ? `Institute email · @${v.email_domain}` : 'Institute email'} />
            <Check ok={v.student_verified} label="Student status" />
            <Check ok={v.phone_verified} label="Phone" />
            <Check ok={v.selfie_verified} label="Selfie check" />
          </Card>
          </>
        )}

        {isMe && (
          <>
            <SectionHeader title="More" />
            <View style={{ gap: 8 }}>
              <ThemeToggle />
              <LinkRow icon="account-multiple-plus-outline" label="Invite friends" detail="Invite 3, skip the line" onPress={() => router.push('/referral')} />
              <LinkRow
                icon="star-four-points-outline"
                label={ambStatus ? 'Ambassador application' : 'Become an ambassador'}
                detail={ambStatus ? AMB_STATUS[ambStatus] : ambUnavailable ? 'Not live yet' : 'Help grow the campus'}
                detailColor={ambStatus === 'approved' ? colors.primary : ambStatus === 'rejected' ? colors.dim : ambStatus || ambUnavailable ? colors.violet : undefined}
                onPress={() => router.push('/ambassador')}
              />
              <LinkRow icon="alarm" label="Movement alarm" detail="No snoozing — move to switch it off" onPress={() => router.push('/alarm')} />
              <LinkRow icon="calendar-check" label="Meetups & check-in" onPress={() => router.push('/meetups')} />
              <LinkRow icon="sword-cross" label="Challenge invites" onPress={() => router.push('/invites')} />
              <LinkRow icon="heart-multiple-outline" label="Date Mode" onPress={() => router.push('/date')} />
              <LinkRow icon="tshirt-crew-outline" label="Avatar & shop" onPress={() => router.push({ pathname: '/avatar', params: { from: 'profile' } })} />
              <LinkRow
                icon="logout"
                label="Sign out"
                onPress={async () => {
                  tap();
                  await signOut();
                  router.replace('/welcome');
                }}
              />
            </View>
          </>
        )}
        {!isMe && userId && <BlockRow userId={userId} name={p.display_name} />}
      </View>
    </ScrollView>
  );
}

/** Block / unblock. Two taps to block. Works both ways: no Squirrel Dates suggestions, follows or challenges. */
function BlockRow({ userId, name }: { userId: string; name: string }) {
  const { toast } = useApp();
  const r = useCampus<BlockState>(`block:${userId}`, () => campusApi.blockStatus(userId));
  const act = useAction((blocked: boolean) => campusApi.setBlocked(userId, blocked));
  const [confirm, setConfirm] = useState(false);
  if (!r.data) return null; // unknown or not live: no half-working button
  const blocked = r.data.blocked;
  const first = name.split(' ')[0];
  const press = async () => {
    tap();
    if (!blocked && !confirm) return setConfirm(true);
    const next = await act.run(!blocked);
    setConfirm(false);
    if (next) {
      r.mutate(next);
      invalidateCampus('dates');
      toast(next.blocked ? `${first} is blocked` : `${first} is unblocked`, next.blocked ? 'account-cancel-outline' : 'account-check-outline', colors.dim);
    }
  };
  return (
    <View style={{ marginTop: 28 }}>
      <LinkRow
        icon={blocked ? 'account-check-outline' : 'account-cancel-outline'}
        label={blocked ? `Unblock ${first}` : confirm ? `Tap again to block ${first}` : `Block ${first}`}
        detail={act.status === 'error' ? errorText(act.error) : blocked ? 'You won’t be suggested to each other' : 'No suggestions, follows or challenges between you'}
        detailColor={act.status === 'error' ? colors.coral : undefined}
        onPress={act.status === 'loading' ? () => undefined : press}
      />
    </View>
  );
}

function StatTile({ icon, v, l, c = colors.text }: { icon: React.ComponentProps<typeof Icon>['name']; v: string; l: string; c?: string }) {
  return (
    <View style={styles.tile} accessibilityLabel={`${l}: ${v}`}>
      <Icon name={icon} size={16} color={c} />
      <Text style={[styles.tileV, { color: c === colors.text ? colors.text : c }]}>{v}</Text>
      <Text style={styles.tileL}>{l}</Text>
    </View>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Icon name={ok ? 'check-circle' : 'circle-outline'} size={18} color={ok ? colors.green : colors.mute} />
      <Text style={[styles.checkText, !ok && { color: colors.dim }]}>{label}</Text>
      <Text style={styles.meta}>{ok ? 'verified' : 'not yet'}</Text>
    </View>
  );
}

const AMB_STATUS: Record<string, string> = { pending: 'In the nest · pending', under_review: 'Under review', approved: 'Approved', rejected: 'Not this time' };

function LinkRow({ icon, label, detail, detailColor = colors.dim, onPress }: { icon: React.ComponentProps<typeof Icon>['name']; label: string; detail?: string; detailColor?: string; onPress: () => void }) {
  return (
    <PressScale onPress={onPress} style={styles.row} scaleTo={0.98} accessibilityRole="button" accessibilityLabel={detail ? `${label}. ${detail}` : label}>
      <Icon name={icon} size={18} color={colors.primary} />
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>{label}</Text>
        {!!detail && <Text style={[styles.rowDetail, { color: detailColor }]} numberOfLines={1}>{detail}</Text>}
      </View>
      <Icon name="chevron-right" size={18} color={colors.dim} />
    </PressScale>
  );
}

const styles = StyleSheet.create({
  private: { marginTop: 18, alignItems: 'center', gap: 8, paddingVertical: 22 },
  privateText: { color: colors.dim, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  topBar: { position: 'absolute', left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', maxWidth: MAX_WIDTH, alignSelf: 'center' },
  col: { paddingHorizontal: 16, width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 3, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 2, backgroundColor: colors.imageChip },
  pillText: { fontFamily: fonts.label, fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase' },
  meta: { color: colors.dim, fontFamily: fonts.mono, fontSize: 11 },
  bio: { color: colors.sub, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, marginTop: 8 },
  sharedLine: { color: colors.sub, fontFamily: fonts.medium, fontSize: 13 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: { width: '23%', flexGrow: 1, minWidth: 76, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: 10, gap: 2 },
  tileV: { fontFamily: fonts.labelBold, fontSize: 19 },
  tileL: { color: colors.dim, fontFamily: fonts.mono, fontSize: 9, letterSpacing: 0.6, textTransform: 'uppercase' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: 12 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  rowTitle: { color: colors.text, fontFamily: fonts.semibold, fontSize: 14 },
  rowDetail: { fontFamily: fonts.regular, fontSize: 12, marginTop: 1 },
  status: { fontFamily: fonts.label, fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase' },
  crew: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1.5, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: colors.card },
  crewText: { color: colors.text, fontFamily: fonts.semibold, fontSize: 13 },
  role: { color: colors.dim, fontFamily: fonts.label, fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase' },
  empty: { color: colors.dim, fontFamily: fonts.regular, fontSize: 13 },
  checkText: { flex: 1, color: colors.text, fontFamily: fonts.medium, fontSize: 13 },
});
