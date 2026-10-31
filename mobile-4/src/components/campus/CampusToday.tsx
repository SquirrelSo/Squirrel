/**
 * Home cards backed by the Social service:
 *  - CampusToday: today's campus activity (GET /v1/stats/daily) + yours, with a 7-day strip.
 *  - WaitlistCard: your waitlist spot / invite progress (GET /v1/me/membership) → /waitlist.
 * Both render nothing when the Social service isn't configured or you're signed out; there is
 * no sample data — every number is the server's.
 */
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { communityApi, type DailyStats, type Membership } from '@/api/community';
import { SOCIAL_API_CONFIGURED } from '@/api/config';
import { useAuth } from '@/auth/AuthProvider';
import { ErrorState, LoadingRows } from '@/components/campus/States';
import { Card, FadeIn, Icon, PressScale, ProgressBar, RowSub, RowTitle } from '@/components/ui';
import { useCampus, useRefreshOnFocus } from '@/hooks/useCampus';
import { alpha, colors, fonts, radius } from '@/theme';

const useSocialLive = () => {
  const { mode } = useAuth();
  return SOCIAL_API_CONFIGURED && mode === 'live';
};

const fmtKm = (km: number) => (km >= 100 ? Math.round(km).toLocaleString('en-IN') : km.toFixed(1));
const weekday = (day: string) => {
  const d = new Date(`${day}T12:00:00`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { weekday: 'narrow' });
};

export function CampusToday() {
  const live = useSocialLive();
  const r = useCampus<DailyStats>('social:stats:daily:7', () => communityApi.dailyStats(7), { needsAuth: false, enabled: live });
  useRefreshOnFocus(r.reload);
  if (!live) return null;
  const s = r.data;

  return (
    <FadeIn>
      <Card style={{ marginTop: 14 }}>
        <View style={styles.head}>
          <Text style={styles.title}>Campus today</Text>
          <Icon name="pulse" size={18} color={colors.secondary} />
        </View>
        {r.error && !s ? (
          <ErrorState cause={r.cause} onRetry={r.reload} compact title="Couldn’t load campus stats" feature="Campus today" />
        ) : !s ? (
          <LoadingRows rows={1} height={96} />
        ) : (
          <>
            <View style={styles.grid}>
              <Stat value={s.today.active_members.toLocaleString('en-IN')} label="Active" color={colors.primary} />
              <Stat value={s.today.runs.toLocaleString('en-IN')} label="Runs" color={colors.secondary} />
              <Stat value={fmtKm(s.today.km)} label="km" color={colors.blue} />
              <Stat value={s.today.workouts.toLocaleString('en-IN')} label="Workouts" color={colors.orange} />
            </View>
            <View style={styles.me}>
              <Text style={styles.meLabel}>You today</Text>
              <Text style={styles.meText}>
                {s.me_today.runs} run{s.me_today.runs === 1 ? '' : 's'} · {fmtKm(s.me_today.km)} km · {s.me_today.workouts} workout{s.me_today.workouts === 1 ? '' : 's'}
              </Text>
            </View>
            {s.days.length > 1 && <WeekStrip days={s.days} />}
          </>
        )}
      </Card>
    </FadeIn>
  );
}

function Stat({ value, label, color }: { value: string; label: string; color: string }) {
  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <Text style={[styles.statValue, { color }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

/** Active members per day, oldest → newest (the server's order); today is the last bar. */
function WeekStrip({ days }: { days: DailyStats['days'] }) {
  const max = Math.max(1, ...days.map((d) => d.active_members));
  return (
    <View style={{ marginTop: 14 }} accessibilityLabel={`Active members, last ${days.length} days: ${days.map((d) => d.active_members).join(', ')}`}>
      <Text style={styles.stripLabel}>Active members · last {days.length} days</Text>
      <View style={styles.strip}>
        {days.map((d, i) => {
          const last = i === days.length - 1;
          return (
            <View key={d.day} style={styles.barCol}>
              <View style={styles.barTrack}>
                <View style={[styles.bar, { height: `${Math.max(4, (d.active_members / max) * 100)}%`, backgroundColor: last ? colors.primary : alpha(colors.primary, 0.35) }]} />
              </View>
              <Text style={[styles.barDay, last && { color: colors.primary }]}>{weekday(d.day)}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

/** Compact Home card → /waitlist. Silent unless the membership actually loaded. */
export function WaitlistCard() {
  const live = useSocialLive();
  const r = useCampus<Membership>('social:membership', () => communityApi.membership(), { needsAuth: false, enabled: live });
  if (!live || !r.data) return null;
  const m = r.data;
  const need = m.referrals_to_skip;
  const sub = m.skipped
    ? `Line skipped · ${m.referrals} invite${m.referrals === 1 ? '' : 's'} joined`
    : `${m.referrals}/${need} invites · invite ${Math.max(0, need - m.referrals)} more to skip the line`;

  return (
    <FadeIn>
      <PressScale onPress={() => router.push('/referral')} scaleTo={0.98} style={{ marginTop: 12 }} accessibilityLabel="Waitlist and invites">
        <View style={styles.wl}>
          <View style={styles.wlIcon}>
            <Icon name={m.admitted ? 'check-decagram' : m.founding ? 'medal' : 'ticket-confirmation-outline'} size={22} color={m.founding ? colors.gold : colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <RowTitle>{m.admitted ? 'You’re in · invite friends' : `You’re #${m.effective_position.toLocaleString('en-IN')} in line`}</RowTitle>
            <RowSub>{m.founding ? `Founding Squirrel #${m.founding.rank} · ${sub}` : sub}</RowSub>
            {!m.skipped && need > 0 && <ProgressBar progress={m.referrals / need} color={colors.primary} color2={colors.secondary} height={4} style={{ marginTop: 8 }} />}
          </View>
          <Icon name="chevron-right" size={24} color={colors.primary} />
        </View>
      </PressScale>
    </FadeIn>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  title: { color: colors.text, fontFamily: fonts.bold, fontSize: 15 },
  grid: { flexDirection: 'row' },
  statValue: { fontFamily: fonts.display, fontSize: 24, letterSpacing: 0.3 },
  statLabel: { color: colors.dim, fontFamily: fonts.label, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' },
  me: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12, backgroundColor: alpha(colors.primary, 0.08), borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 8 },
  meLabel: { color: colors.primary, fontFamily: fonts.labelBold, fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase' },
  meText: { flex: 1, color: colors.sub, fontFamily: fonts.medium, fontSize: 12 },
  stripLabel: { color: colors.dim, fontFamily: fonts.label, fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 },
  strip: { flexDirection: 'row', gap: 6, height: 64 },
  barCol: { flex: 1, alignItems: 'center' },
  barTrack: { flex: 1, width: '100%', justifyContent: 'flex-end' },
  bar: { width: '100%', borderRadius: 4 },
  barDay: { color: colors.mute, fontFamily: fonts.label, fontSize: 10, marginTop: 4, textTransform: 'uppercase' },
  wl: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: alpha(colors.primary, 0.45), padding: 14 },
  wlIcon: { width: 42, height: 42, borderRadius: 13, backgroundColor: alpha(colors.primary, 0.12), alignItems: 'center', justifyContent: 'center' },
});
