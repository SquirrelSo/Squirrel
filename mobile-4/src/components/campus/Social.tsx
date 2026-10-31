/**
 * Reusable social pieces: icebreakers, the Open to Meet toggle, badges, and the
 * activity-first person card used by Friend Mode, Date Mode and Active Now.
 */
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { router } from 'expo-router';
import { BadgeArt } from '@/art/Badge';
import { campusApi, errorText, type Badge, type Icebreaker, type PersonCard, type Proximity } from '@/api/campus';
import { PersonAvatar } from '@/components/campus/PersonAvatar';
import { km } from '@/components/campus/territoryUi';
import { PokeButton } from '@/components/social/PokeButton';
import { Card, Icon, PressScale, ProgressBar, tap } from '@/components/ui';
import { invalidateCampus, useAction } from '@/hooks/useCampus';
import type { BadgeKind } from '@/types';
import { alpha, colors, fonts, radius } from '@/theme';

// ---------------------------------------------------------------------------
// Icebreakers — rendered verbatim from the backend; hidden when there are none.
// ---------------------------------------------------------------------------

export function Icebreakers({ items, targetUserId, max = 3, title = 'Icebreakers' }: { items: Icebreaker[] | undefined; targetUserId?: string; max?: number; title?: string }) {
  if (!items?.length) return null; // never invent one
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Icon name="chat-processing-outline" size={15} color={colors.primary} />
        <Text style={styles.ibTitle}>{title}</Text>
      </View>
      {items.slice(0, max).map((ib) => {
        const challenge = ib.action?.type === 'challenge' && targetUserId;
        return (
          <PressScale
            key={ib.id}
            onPress={() => (challenge ? router.push({ pathname: '/invite/new', params: { userId: targetUserId, zoneId: ib.action?.zone_id ?? '' } }) : tap())}
            scaleTo={0.98}
            style={[styles.ib, challenge && { borderColor: alpha(colors.secondary, 0.5) }]}
            accessibilityLabel={ib.text}>
            <Text style={styles.ibText}>“{ib.text}”</Text>
            {challenge && (
              <View style={styles.ibAction}>
                <Icon name="sword-cross" size={12} color={colors.secondary} />
                <Text style={styles.ibActionText}>Challenge</Text>
              </View>
            )}
          </PressScale>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Open to Meet
// ---------------------------------------------------------------------------

/** ON / OFF / loading / error. The switch shows the server's answer, not the tap. */
export function OpenToMeetToggle({ value, onChange }: { value: boolean; onChange?: (v: boolean) => void }) {
  const [enabled, setEnabled] = useState(value);
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    // The profile reloaded with a newer server value.
    setSynced(value);
    setEnabled(value);
  }
  const act = useAction((v: boolean) => campusApi.setOpenToMeet(v));
  const toggle = async (next: boolean) => {
    tap();
    const r = await act.run(next);
    if (r) {
      setEnabled(r.enabled);
      invalidateCampus('me');
      invalidateCampus('active');
      onChange?.(r.enabled);
    }
  };
  const loading = act.status === 'loading';
  return (
    <Card style={[styles.otm, enabled && { borderColor: colors.primary }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={[styles.otmDot, { backgroundColor: enabled ? colors.primary : colors.cardHi }]}>
          <Icon name={enabled ? 'hand-wave' : 'hand-back-left-off-outline'} size={20} color={enabled ? colors.onPrimary : colors.dim} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.otmTitle}>Open to Meet · {loading ? 'saving…' : enabled ? 'ON' : 'OFF'}</Text>
          <Text style={styles.otmBody}>
            {enabled
              ? 'You can show up in Squirrels Near You and Active Now for relevant IRL plans. Your exact location is never shared.'
              : 'Turn on to be discoverable for runs, walks and meetups nearby. Only a rough distance is ever shown.'}
          </Text>
        </View>
        {loading ? (
          <ActivityIndicator color={colors.primary} />
        ) : (
          <Switch
            value={enabled}
            onValueChange={toggle}
            trackColor={{ false: colors.lineHi, true: colors.primaryDeep }}
            thumbColor={enabled ? colors.primary : colors.dim}
            accessibilityLabel="Open to Meet"
          />
        )}
      </View>
      {act.status === 'error' && (
        <View style={styles.otmErr}>
          <Icon name="alert-circle-outline" size={14} color={colors.coral} />
          <Text style={styles.otmErrText}>{errorText(act.error)} Your setting didn’t change.</Text>
        </View>
      )}
      <Text style={styles.otmFine}>The backend decides who actually sees you (campus-only, blocked users never).</Text>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Badges — registry maps backend badge ids to art; unknown ids still render.
// ---------------------------------------------------------------------------

const BADGE_ART: Record<string, BadgeKind> = {
  early_bird: 'early-bird',
  night_owl: 'night-owl',
  park_regular: 'park-regular',
  founding_squirrel: 'founding-squirrel',
};
export const badgeArt = (id: string): BadgeKind => BADGE_ART[id] ?? 'city';

export function BadgeTile({ badge, size = 72, compact }: { badge: Badge; size?: number; compact?: boolean }) {
  const pct = badge.progress ? Math.min(1, badge.progress.current / Math.max(1, badge.progress.target)) : badge.unlocked ? 1 : 0;
  return (
    <View style={[styles.badge, compact && { width: size + 16, padding: 6 }]} accessibilityLabel={`${badge.name}, ${badge.unlocked ? 'unlocked' : 'locked'}`}>
      <View>
        <BadgeArt kind={badgeArt(badge.id)} size={size} locked={!badge.unlocked} />
        {!badge.unlocked && (
          <View style={styles.badgeLock}>
            <Icon name="lock" size={11} color={colors.text} />
          </View>
        )}
      </View>
      <Text style={styles.badgeName} numberOfLines={1}>{badge.name}</Text>
      {!compact && <Text style={styles.badgeDesc} numberOfLines={2}>{badge.description}</Text>}
      {!badge.unlocked && badge.progress && (
        <View style={{ alignSelf: 'stretch', marginTop: 4 }}>
          <ProgressBar progress={pct} color={colors.purple} height={4} />
          <Text style={styles.badgeProg}>
            {badge.progress.current}/{badge.progress.target}
          </Text>
        </View>
      )}
      {badge.unlocked && !compact && <Text style={styles.badgeUnlocked}>Unlocked</Text>}
    </View>
  );
}

export function BadgeRow({ badges }: { badges: Badge[] }) {
  if (!badges.length) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {badges.map((b) => (
        <BadgeTile key={b.id} badge={b} size={52} compact />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Person card (activity-first)
// ---------------------------------------------------------------------------

const MODE_UI = {
  friends: { label: 'Friends', icon: 'account-heart-outline', color: colors.primary },
  crew: { label: 'Crew', icon: 'account-group-outline', color: colors.blue },
  date: { label: 'Date', icon: 'heart-outline', color: colors.secondary },
} as const;
export const modeUi = (m: string | null | undefined) => (m && m in MODE_UI ? MODE_UI[m as keyof typeof MODE_UI] : null);

export const PROXIMITY_TEXT: Record<Proximity, string> = { very_close: 'Very close', nearby: 'Nearby', on_campus: 'On campus' };

export function ModeChip({ mode }: { mode: string | null | undefined }) {
  const m = modeUi(mode);
  if (!m) return null;
  return (
    <View style={[styles.chip, { borderColor: m.color }]}>
      <Icon name={m.icon} size={11} color={m.color} />
      <Text style={[styles.chipText, { color: m.color }]}>{m.label}</Text>
    </View>
  );
}

export function PersonCardView({ p, extra, onChallenge, showIcebreakers = true }: { p: PersonCard; extra?: React.ReactNode; onChallenge?: () => void; showIcebreakers?: boolean }) {
  const a = p.activity;
  return (
    <Card style={{ gap: 10 }}>
      <Pressable onPress={() => router.push({ pathname: '/user/[id]', params: { id: p.user_id } })} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }} accessibilityRole="button" accessibilityLabel={`Open ${p.display_name}`}>
        <PersonAvatar person={p} size={48} link={false} />
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Text style={styles.name}>{p.display_name}</Text>
            <ModeChip mode={p.connection_mode} />
          </View>
          <Text style={styles.sub} numberOfLines={1}>{[p.hostel, p.bio].filter(Boolean).join(' · ')}</Text>
        </View>
        {extra}
      </Pressable>
      {/* Activity first */}
      <View style={styles.actRow}>
        <View style={styles.act}>
          <Icon name={a.top_activity === 'walk' ? 'walk' : 'run-fast'} size={14} color={colors.primary} />
          <Text style={styles.actText}>{a.runs_30d} {a.top_activity === 'walk' ? 'walks' : 'runs'} · 30d</Text>
        </View>
        <View style={styles.act}>
          <Icon name="map-marker-distance" size={14} color={colors.blue} />
          <Text style={styles.actText}>{km(a.distance_30d_m, 0)}</Text>
        </View>
        {a.usual_time && (
          <View style={styles.act}>
            <Icon name={a.usual_time === 'morning' ? 'weather-sunset-up' : a.usual_time === 'night' ? 'weather-night' : 'weather-sunset-down'} size={14} color={colors.gold} />
            <Text style={styles.actText}>{a.usual_time}</Text>
          </View>
        )}
      </View>
      {(p.shared.shared_zones.length > 0 || p.shared.shared_crews.length > 0) && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {p.shared.shared_zones.slice(0, 3).map((z) => (
            <View key={z.zone_id} style={styles.shared}>
              <Icon name="map-marker-radius" size={11} color={colors.primary} />
              <Text style={styles.sharedText}>{z.zone_name}</Text>
            </View>
          ))}
          {p.shared.shared_crews.slice(0, 2).map((c) => (
            <View key={c.id} style={styles.shared}>
              <Icon name="account-group" size={11} color={colors.blue} />
              <Text style={styles.sharedText}>{c.name}</Text>
            </View>
          ))}
        </View>
      )}
      {showIcebreakers && <Icebreakers items={p.shared.icebreakers} targetUserId={p.user_id} max={2} />}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <PokeButton user={p} size="sm" />
      {onChallenge && (
        <Pressable onPress={onChallenge} style={styles.challenge} accessibilityRole="button" accessibilityLabel={`Challenge ${p.display_name}`}>
          <Icon name="sword-cross" size={14} color={colors.secondary} />
          <Text style={styles.challengeText}>Challenge invite</Text>
        </Pressable>
      )}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  ibTitle: { color: colors.primary, fontFamily: fonts.label, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' },
  ib: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.cardHi, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 12, paddingVertical: 10 },
  ibText: { flex: 1, color: colors.text, fontFamily: fonts.medium, fontSize: 13, lineHeight: 18 },
  ibAction: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  ibActionText: { color: colors.secondary, fontFamily: fonts.label, fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase' },
  otm: { gap: 8 },
  otmDot: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  otmTitle: { color: colors.text, fontFamily: fonts.label, fontSize: 16, letterSpacing: 0.8, textTransform: 'uppercase' },
  otmBody: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, marginTop: 2 },
  otmErr: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  otmErrText: { flex: 1, color: colors.coral, fontFamily: fonts.medium, fontSize: 12 },
  otmFine: { color: colors.mute, fontFamily: fonts.mono, fontSize: 10 },
  badge: { width: 150, alignItems: 'center', backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 12, gap: 2 },
  badgeLock: { position: 'absolute', right: -2, bottom: 0, width: 22, height: 22, borderRadius: 11, backgroundColor: colors.cardHi, borderWidth: 1, borderColor: colors.lineHi, alignItems: 'center', justifyContent: 'center' },
  badgeName: { color: colors.text, fontFamily: fonts.label, fontSize: 13, letterSpacing: 0.6, textTransform: 'uppercase', marginTop: 4, textAlign: 'center' },
  badgeDesc: { color: colors.dim, fontFamily: fonts.regular, fontSize: 11, lineHeight: 15, textAlign: 'center' },
  badgeProg: { color: colors.violet, fontFamily: fonts.mono, fontSize: 10, textAlign: 'center', marginTop: 3 },
  badgeUnlocked: { color: colors.primary, fontFamily: fonts.label, fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', marginTop: 4 },
  name: { color: colors.text, fontFamily: fonts.bold, fontSize: 16 },
  sub: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, marginTop: 2 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 3, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 6, paddingVertical: 1 },
  chipText: { fontFamily: fonts.label, fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase' },
  actRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  act: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: colors.cardHi, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 5 },
  actText: { color: colors.sub, fontFamily: fonts.medium, fontSize: 12 },
  shared: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3 },
  sharedText: { color: colors.sub, fontFamily: fonts.medium, fontSize: 11 },
  challenge: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', borderWidth: 1, borderColor: alpha(colors.secondary, 0.5), borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6 },
  challengeText: { color: colors.secondary, fontFamily: fonts.label, fontSize: 12, letterSpacing: 0.8, textTransform: 'uppercase' },
});
