/**
 * The ambassador's own view (GET /v1/ambassador/me): role status, referral code and invite link,
 * counts, then tasks, referrals and the ambassador leaderboard. Every number is the server's — the
 * app never adds up or awards XP.
 */
import { Platform, Share, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { AmbassadorMe } from '@/api/ambassador';
import { shortTime } from '@/components/campus/territoryUi';
import { AmbassadorLeaderboard } from '@/components/ambassador/Leaderboard';
import { AmbassadorReferrals } from '@/components/ambassador/Referrals';
import { AmbassadorTasks } from '@/components/ambassador/Tasks';
import { Button, Card, Icon } from '@/components/ui';
import { useApp } from '@/state/AppState';
import { alpha, colors, fonts, radius } from '@/theme';

export function AmbassadorDashboard({ me }: { me: AmbassadorMe }) {
  const suspended = me.status === 'suspended';
  return (
    <>
      <Card style={[styles.status, { borderColor: alpha(suspended ? colors.coral : colors.primary, 0.45) }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Icon name={suspended ? 'pause-circle-outline' : 'check-decagram'} size={24} color={suspended ? colors.coral : colors.primary} />
          <Text style={[styles.statusText, { color: suspended ? colors.coral : colors.primary }]}>{suspended ? 'Paused' : 'Active'}</Text>
          <View style={{ flex: 1 }} />
          <Text style={styles.mono}>Since {shortTime(suspended && me.suspended_at ? me.suspended_at : me.approved_at)}</Text>
        </View>
        <Text style={styles.body}>
          {suspended
            ? me.suspension_reason ?? 'Your ambassador role is paused. Tasks can’t be submitted and referral rewards wait until it’s back.'
            : 'You’re a Squirrel ambassador. Bring people in with your code and pick up tasks below.'}
        </Text>
        {suspended && !!me.suspension_reason && <Text style={styles.hint}>Referral rewards wait until your role is back.</Text>}
      </Card>

      <InviteCard code={me.referral_code} url={me.invite_url} />

      <Text style={styles.section}>Your numbers</Text>
      <View style={styles.grid}>
        <Stat label="Joined" value={me.counts.referred} icon="account-plus-outline" />
        <Stat label="Verified" value={me.counts.verified} icon="email-check-outline" />
        <Stat label="Active" value={me.counts.activated} icon="run-fast" />
        <Stat label="Rewarded" value={me.counts.rewarded} icon="gift-outline" />
        <Stat label="Referral XP" value={me.counts.referral_xp} icon="star-four-points-outline" color={colors.gold} />
        <Stat label="Task XP" value={me.counts.task_xp} icon="clipboard-check-outline" color={colors.gold} />
      </View>

      <Text style={styles.section}>Tasks</Text>
      <AmbassadorTasks suspended={suspended} />

      <Text style={styles.section}>People you brought in</Text>
      <AmbassadorReferrals />

      <Text style={styles.section}>Ambassador leaderboard</Text>
      <AmbassadorLeaderboard />
    </>
  );
}

function InviteCard({ code, url }: { code: string; url: string | null }) {
  const { toast } = useApp();
  const message = `Join me on Squirrel Social: runs, workouts and crews on campus. Use my invite code ${code}${url ? `: ${url}` : ''}`;
  const copy = async (text: string, what: string) => {
    try {
      await Clipboard.setStringAsync(text);
      toast(`${what} copied`, 'content-copy', colors.primary);
    } catch {
      toast('Couldn’t copy — try again', 'alert-circle-outline', colors.coral);
    }
  };
  const share = () => Share.share(Platform.OS === 'ios' && url ? { message, url } : { message }).catch(() => undefined);
  return (
    <Card style={{ marginTop: 14 }}>
      <Text style={styles.label}>Your referral code</Text>
      <Text style={styles.code} selectable>{code}</Text>
      {url ? <Text style={styles.url} selectable numberOfLines={1}>{url}</Text> : <Text style={styles.hint}>No invite link yet. Your code works on its own.</Text>}
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
        <Button label="Copy" size="md" variant="secondary" iconLeft="content-copy" onPress={() => copy(url ?? code, url ? 'Invite link' : 'Code')} style={{ flex: 1 }} />
        <Button label="Share" size="md" iconLeft="share-variant" onPress={share} style={{ flex: 1 }} />
      </View>
    </Card>
  );
}

function Stat({ label, value, icon, color = colors.text }: { label: string; value: number; icon: React.ComponentProps<typeof Icon>['name']; color?: string }) {
  return (
    <View style={styles.stat} accessibilityLabel={`${label}: ${value}`}>
      <Icon name={icon} size={16} color={colors.dim} />
      <Text style={[styles.statValue, { color }]}>{value.toLocaleString('en-IN')}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  status: { marginTop: 18, gap: 10 },
  statusText: { fontFamily: fonts.display, fontSize: 24, letterSpacing: 0.4, textTransform: 'uppercase' },
  mono: { color: colors.mute, fontFamily: fonts.mono, fontSize: 11 },
  body: { color: colors.sub, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20 },
  hint: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, marginTop: 6 },
  label: { color: colors.dim, fontFamily: fonts.medium, fontSize: 12 },
  code: { color: colors.primary, fontFamily: fonts.monoBold, fontSize: 30, letterSpacing: 6, marginTop: 6 },
  url: { color: colors.sub, fontFamily: fonts.mono, fontSize: 12, marginTop: 6 },
  section: { color: colors.dim, fontFamily: fonts.labelBold, fontSize: 13, letterSpacing: 1.4, textTransform: 'uppercase', marginTop: 22, marginBottom: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stat: { flexBasis: '31%', flexGrow: 1, gap: 2, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: 10 },
  statValue: { fontFamily: fonts.display, fontSize: 22 },
  statLabel: { color: colors.dim, fontFamily: fonts.label, fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase' },
});
