import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { API_CONFIGURED } from '@/api/config';
import { challengeErrorText, runChallengesApi, runChallengesLive } from '@/api/runChallenges';
import { useRemote } from '@/api/useRemote';
import { useAuth } from '@/auth/AuthProvider';
import { NotConnected } from '@/components/campus/States';
import { Button, Card, Display, EmptyState, FadeIn, Header, Icon, Kicker, ProgressBar, Screen, Segmented, Tagline, tap } from '@/components/ui';
import type { IconName } from '@/data/icons';
import { fmtEnds, fmtMetric, goalFromRun, minutesUntil, sortGoals, type Challenge, type ChallengeKind } from '@/logic/challenges';
import { useApp } from '@/state/AppState';
import { colors, fonts, radius } from '@/theme';

const TABS = ['Daily', 'Group'] as const;
type Tab = (typeof TABS)[number];
const KIND: Record<Tab, ChallengeKind> = { Daily: 'daily', Group: 'group' };
const EMPTY: Record<Tab, { title: string; body: string }> = {
  Daily: { title: 'No daily challenges', body: 'Daily challenges you’re in, or invited to, show up here.' },
  Group: { title: 'No group goals', body: 'When you’re invited to a group goal, it lands here.' },
};
const ICON: Record<ChallengeKind, IconName> = { daily: 'calendar-today', group: 'account-group' };

/**
 * GOALS — the Run Module's challenges (GET /v1/challenges/mine): dailies and group goals you're in
 * or invited to. Progress counts verified runs in the window and results resolve on the server;
 * nothing to claim, and there's no leaving one. Duels and territory battles live elsewhere.
 */
export default function Challenges() {
  const { mode } = useAuth();
  const { toast } = useApp();
  const live = runChallengesLive(mode);
  // Cards are built when the list arrives (a card's state depends on the time), and rebuilt on each reload.
  const remote = useRemote(live ? 'run:challenges:mine' : null, loadGoals);
  const all = remote.data ?? [];
  const [tab, setTab] = useState<Tab>('Daily');
  const list = all.filter((c) => c.kind === KIND[tab]);
  const [busy, setBusy] = useState<string | null>(null);

  const answer = useCallback(
    async (c: Challenge, action: 'accept' | 'decline') => {
      if (busy) return;
      setBusy(c.id);
      try {
        await runChallengesApi[action](c.id);
        tap('success');
        toast(action === 'accept' ? `You're in · ${c.title}` : 'Invite declined', action === 'accept' ? 'flag-checkered' : 'close', action === 'accept' ? colors.primary : colors.dim);
      } catch (e) {
        toast(challengeErrorText(e), 'alert-circle-outline', colors.coral);
      } finally {
        setBusy(null);
        remote.reload();
      }
    },
    [busy, remote, toast],
  );

  const unauthorized = remote.error != null && /401|sign in|token/i.test(remote.error);
  return (
    <Screen tabBar={false}>
      <Header back title="" right={<Text style={styles.link} onPress={() => router.push('/missions')}>Today’s goals →</Text>} />
      <Kicker>Challenges</Kicker>
      <Display size={48} style={{ marginTop: 6, lineHeight: 50 }}>
        Choose your{'\n'}
        <Text style={{ color: colors.secondary }}>battle.</Text>
      </Display>
      <Tagline size={16} rotate={-2} style={{ marginTop: 6 }}>Progress counts itself. Just move.</Tagline>
      <Segmented items={[...TABS]} value={tab} onChange={setTab} />
      {!live ? (
        <NotConnected
          name="Challenges"
          reason={API_CONFIGURED ? 'signed_out' : 'not_configured'}
          body={API_CONFIGURED ? 'Challenges come from your account. Sign in to see them and answer invites.' : 'Challenges come from the Run Module, which isn’t connected to this build yet (EXPO_PUBLIC_API_URL).'}
        />
      ) : !remote.data && remote.loading ? (
        <View style={{ gap: 12 }}>
          {[0, 1].map((i) => (
            <Card key={i} style={{ opacity: 0.5 }}>
              <Text style={styles.meta}>Loading challenges…</Text>
              <ProgressBar progress={0} height={10} style={{ marginTop: 14 }} />
            </Card>
          ))}
        </View>
      ) : !remote.data && remote.error ? (
        <EmptyState
          title={unauthorized ? 'Sign in again' : "Couldn't load challenges"}
          body={unauthorized ? 'Your session expired. Sign in to see your challenges.' : remote.error}
          action={unauthorized ? 'Sign in' : 'Try again'}
          onAction={unauthorized ? () => router.push('/sign-in') : remote.reload}
        />
      ) : list.length === 0 ? (
        <EmptyState title={EMPTY[tab].title} body={EMPTY[tab].body} />
      ) : (
        <View style={{ gap: 12 }}>
          {list.map((c, i) => (
            <FadeIn key={c.id} index={i}>
              <ChallengeCard c={c} busy={busy === c.id} onAnswer={answer} />
            </FadeIn>
          ))}
        </View>
      )}
      {remote.data && remote.error && <Text style={[styles.meta, { marginTop: 10, color: colors.coral }]}>Showing the last update · {remote.error}</Text>}
      <View style={styles.note}>
        <Icon name="information-outline" size={16} color={colors.dim} />
        <Text style={styles.noteText}>Challenges count your verified runs in their window, and XP lands automatically when they resolve. Today’s goals are on Home.</Text>
      </View>
    </Screen>
  );
}

const loadGoals = async (): Promise<Challenge[]> => {
  const now = Date.now();
  return sortGoals((await runChallengesApi.mine()).map((r) => goalFromRun(r, now)).filter((c): c is Challenge => c !== null));
};

/** Result, invite answer, or "you're in" — whichever applies. */
function Footer({ c, color, busy, onAnswer }: { c: Challenge; color: string; busy: boolean; onAnswer: (c: Challenge, a: 'accept' | 'decline') => void }) {
  const line =
    c.result?.won
      ? { text: `Completed · +${c.result.xp} XP`, color: colors.primary, icon: 'check-decagram' as IconName }
      : c.result
        ? { text: c.kind === 'group' ? 'Ended · the group fell short' : 'Ended · not completed', color: colors.dim, icon: 'timer-sand-complete' as IconName }
        : c.state === 'cancelled'
          ? { text: 'Cancelled', color: colors.dim, icon: 'cancel' as IconName }
          : c.state === 'ended'
            ? { text: 'Ended · results on the way', color: colors.dim, icon: 'timer-sand' as IconName }
            : null;
  if (line) {
    return (
      <View style={styles.result}>
        <Icon name={line.icon} size={16} color={line.color} />
        <Text style={[styles.resultText, { color: line.color }]}>{line.text}</Text>
      </View>
    );
  }
  if (c.myStatus === 'invited') {
    return (
      <View style={styles.actions}>
        <Button label="Accept" size="sm" disabled={busy} onPress={() => onAnswer(c, 'accept')} style={{ flex: 1 }} />
        <Button label="Decline" size="sm" variant="ghost" disabled={busy} onPress={() => onAnswer(c, 'decline')} style={{ flex: 1 }} />
      </View>
    );
  }
  return <Text style={[styles.meta, { color, marginTop: 12 }]}>{c.state === 'upcoming' ? 'You’re in · starts soon' : 'You’re in · progress counts automatically'}</Text>;
}

function ChallengeCard({ c, busy, onAnswer }: { c: Challenge; busy: boolean; onAnswer: (c: Challenge, a: 'accept' | 'decline') => void }) {
  const color = c.kind === 'daily' ? colors.primary : colors.purple;
  const when = c.state === 'cancelled' ? 'Cancelled' : c.state === 'ended' ? 'Ended' : c.state === 'upcoming' ? 'Starts soon' : `${fmtEnds(minutesUntil(c.endsAt))} · auto-resolves`;
  const target = c.comparator === 'lte' ? `at most ${fmtMetric(c.goal, c.metric)}` : fmtMetric(c.goal, c.metric);
  const toward = c.group ? c.group.value : c.mine;
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={[styles.icon, { borderColor: color }]}>
          <Icon name={ICON[c.kind]} size={20} color={color} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{c.title}</Text>
          <Text style={styles.meta}>{when}</Text>
        </View>
        {c.xp > 0 && (
          <View style={[styles.xp, { borderColor: color }]}>
            <Text style={[styles.xpText, { color }]}>+{c.xp} XP</Text>
          </View>
        )}
      </View>
      {c.group && (
        <Text style={[styles.meta, { marginTop: 12 }]}>
          Group goal · {c.group.members} {c.group.members === 1 ? 'member' : 'members'}
        </Text>
      )}
      <ProgressBar progress={c.goal > 0 ? Math.min(1, toward / c.goal) : 0} color={color} height={10} style={{ marginTop: c.group ? 6 : 14 }} />
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
        <Text style={styles.status}>
          {fmtMetric(toward, c.metric)} / {target}
        </Text>
        {c.group && <Text style={[styles.status, { color }]}>You: {fmtMetric(c.mine, c.metric)}</Text>}
      </View>
      <Footer c={c} color={color} busy={busy} onAnswer={onAnswer} />
    </Card>
  );
}

const styles = StyleSheet.create({
  link: { color: colors.primary, fontFamily: fonts.label, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' },
  icon: { width: 40, height: 40, borderRadius: 20, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.text, fontFamily: fonts.label, fontSize: 16, letterSpacing: 0.6, textTransform: 'uppercase' },
  meta: { color: colors.dim, fontFamily: fonts.mono, fontSize: 10, marginTop: 2 },
  xp: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 7, paddingVertical: 3 },
  xpText: { fontFamily: fonts.monoBold, fontSize: 11 },
  status: { color: colors.sub, fontFamily: fonts.mono, fontSize: 11, marginTop: 8 },
  note: { flexDirection: 'row', gap: 8, marginTop: 18, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, borderStyle: 'dashed', padding: 12 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  result: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12 },
  resultText: { fontFamily: fonts.label, fontSize: 13, letterSpacing: 0.8, textTransform: 'uppercase' },
  noteText: { flex: 1, color: colors.dim, fontFamily: fonts.regular, fontSize: 12, lineHeight: 17 },
});
