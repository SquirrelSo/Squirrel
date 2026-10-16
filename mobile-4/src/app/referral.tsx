import { useState } from 'react';
import { Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { communityApi } from '@/api/community';
import { SOCIAL_API_CONFIGURED } from '@/api/config';
import { socialErrorText } from '@/api/social';
import { invalidateRemote, useRemote } from '@/api/useRemote';
import { useAuth } from '@/auth/AuthProvider';
import { ErrorState, LoadingRows } from '@/components/campus/States';
import { Button, Card, Display, EmptyState, Header, Icon, Kicker, ProgressBar, Screen } from '@/components/ui';
import { useApp } from '@/state/AppState';
import { colors, fonts, radius } from '@/theme';

/**
 * Your place in line and your invite code (GET /v1/me/membership). Everyone is in straight away;
 * three friends who join with your code and verify their college email move you to the front.
 * The first verified members are Founding Squirrels (first 15) and the Founding 500.
 */
export default function ReferralRoute() {
  const { mode } = useAuth();
  if (mode === 'live' && SOCIAL_API_CONFIGURED) return <Invite />;
  return (
    <Screen tabBar={false}>
      <Header back title="Invite friends" />
      <EmptyState title="Sign in to get your invite code" body="Your code and your place in line live on your account." action="Sign in" onAction={() => router.push('/sign-in')} />
    </Screen>
  );
}

function Invite() {
  const { toast } = useApp();
  const m = useRemote('campus:membership', () => communityApi.membership());
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  if (!m.data) {
    return (
      <Screen tabBar={false}>
        <Header back title="Invite friends" />
        {m.error ? <ErrorState cause={m.cause} onRetry={m.reload} /> : <LoadingRows rows={3} height={90} />}
      </Screen>
    );
  }
  const d = m.data;
  const left = Math.max(0, d.referrals_to_skip - d.referrals);
  const message = `Join me on Squirrel Social: runs, workouts and crews on campus. Use my invite code ${d.referral_code}${d.invite_url ? `: ${d.invite_url}` : ''}`;

  const claim = async () => {
    setBusy(true);
    try {
      await communityApi.claimReferral(code);
      invalidateRemote('campus:membership');
      invalidateRemote('campus:me');
      toast('Invite code added. Welcome in!', 'account-heart', colors.primary);
      m.reload();
    } catch (e) {
      toast(socialErrorText(e), 'alert-circle', colors.secondary);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen tabBar={false}>
      <Header back title="Invite friends" />
      <Kicker>You&apos;re in · #{d.effective_position} of {d.members_total}</Kicker>
      <Display size={40} style={{ marginTop: 6 }}>
        {d.skipped ? <>You <Text style={{ color: colors.primary }}>skipped the line</Text></> : <>Invite 3, <Text style={{ color: colors.primary }}>skip the line</Text></>}
      </Display>

      {d.founding && (
        <Card style={{ marginTop: 14 }} glow={colors.gold}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Icon name="medal" size={34} color={colors.gold} />
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{d.founding.title}</Text>
              <Text style={styles.sub}>Member #{d.founding.rank} · the badge is on your profile</Text>
            </View>
          </View>
        </Card>
      )}

      <Card style={{ marginTop: 14 }}>
        <Text style={styles.label}>Your invite code</Text>
        <Text style={styles.code} selectable>{d.referral_code}</Text>
        <ProgressBar progress={Math.min(1, d.referrals / d.referrals_to_skip)} style={{ marginTop: 12 }} />
        <Text style={styles.sub}>
          {d.skipped
            ? `${d.referrals} friends joined with your code. You're at the front of the line.`
            : `${d.referrals} of ${d.referrals_to_skip} friends joined · ${left} more to skip the line`}
        </Text>
        <Text style={styles.hint}>A friend counts once they sign up with their college email and enter your code.</Text>
        <Button label="Share invite" icon="share-variant" onPress={() => Share.share({ message }).catch(() => undefined)} style={{ marginTop: 14 }} />
      </Card>

      <Card style={{ marginTop: 14 }}>
        <Text style={styles.label}>Your place in line</Text>
        <Text style={styles.title}>#{d.effective_position}{d.effective_position !== d.position ? ` (joined #${d.position})` : ''}</Text>
        <Text style={styles.hint}>Everyone&apos;s in already: the line decides who gets new features first.</Text>
      </Card>

      {d.referred_by ? (
        <Text style={[styles.hint, { marginTop: 14 }]}>You joined with {d.referred_by.display_name}&apos;s invite.</Text>
      ) : (
        <Card style={{ marginTop: 14 }}>
          <Text style={styles.label}>Got a friend&apos;s code?</Text>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
            <TextInput style={styles.input} value={code} onChangeText={setCode} placeholder="ABCD2345" placeholderTextColor={colors.mute} autoCapitalize="characters" autoCorrect={false} maxLength={16} />
            <Button label="Add" size="md" disabled={busy || code.trim().length < 4} onPress={claim} />
          </View>
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { color: colors.dim, fontFamily: fonts.medium, fontSize: 12 },
  code: { color: colors.primary, fontFamily: fonts.monoBold, fontSize: 30, letterSpacing: 6, marginTop: 6 },
  title: { color: colors.text, fontFamily: fonts.bold, fontSize: 16, marginTop: 4 },
  sub: { color: colors.sub, fontFamily: fonts.medium, fontSize: 13, marginTop: 8 },
  hint: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, marginTop: 6, lineHeight: 17 },
  input: { flex: 1, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, color: colors.text, fontFamily: fonts.mono, fontSize: 16, letterSpacing: 2 },
});
