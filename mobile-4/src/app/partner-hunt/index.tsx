/**
 * PARTNER HUNT — the hub: what's in the way (age, XP, preferences), and the way in to your board,
 * your preferences, and your requests and connections. Everything comes from Exercise's status call,
 * which never fails for a closed gate: locked is a state to show.
 */
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { errorCode, errorText } from '@/api/campus';
import { errorDetail } from '@/api/partnerHunt';
import { BlockerCard } from '@/components/partnerHunt/Parts';
import { LoadingRows, NotConnected } from '@/components/campus/States';
import { Button, Display, Header, Icon, Kicker, PressScale, Screen, Tagline, tap } from '@/components/ui';
import { usePartnerHuntUser, usePartnerRequests, usePartnerStatus } from '@/hooks/usePartnerHunt';
import { boardBlocker, statusBlocker } from '@/logic/partnerHunt';
import { colors, fonts, radius } from '@/theme';

export default function PartnerHuntHome() {
  const user = usePartnerHuntUser();
  const status = usePartnerStatus();
  const requests = usePartnerRequests();
  const s = status.data;
  const blocker = s ? statusBlocker(s) : status.cause ? boardBlocker(errorCode(status.cause), errorDetail(status.cause), errorText(status.cause)) : null;
  const incoming = requests.data?.incoming.length ?? 0;
  const connections = requests.data?.connections.length ?? 0;
  const go = (path: Parameters<typeof router.push>[0]) => () => {
    tap();
    router.push(path);
  };

  return (
    <Screen tabBar={false}>
      <Header back title="" />
      <Kicker>Partner Hunt</Kicker>
      <Display size={40} style={{ marginTop: 4 }}>
        Find your{'\n'}
        <Text style={{ color: colors.primary }}>training buddy</Text>
      </Display>
      <Tagline size={16} rotate={-2} style={{ marginTop: 6 }}>Anonymous until you both say yes.</Tagline>

      {!user.configured || user.signedOut ? (
        <NotConnected name="Partner Hunt" reason={user.configured ? 'signed_out' : 'not_configured'} body={user.configured ? 'Partner Hunt uses your account. Sign in to find a training buddy.' : 'Partner Hunt runs on the Exercise backend, which isn’t connected to this build (EXPO_PUBLIC_EXERCISE_API_URL).'} />
      ) : !s && !status.cause ? (
        <LoadingRows rows={3} height={80} />
      ) : (
        <View style={{ gap: 12, marginTop: 16 }}>
          {blocker && <BlockerCard blocker={blocker} onRetry={status.reload} />}
          {s?.ready && <Button label="See your matches" iconLeft="account-search" onPress={go('/partner-hunt/matching')} />}
          {s && blocker?.kind !== 'age' && (
            <Row icon="tune-variant" title={s.preferences ? 'Your preferences' : 'Set your preferences'} detail={s.preferences ? (s.preferences.visible ? 'Showing you to matches' : 'Hidden: you won’t see the board') : 'What you train, when and where'} onPress={go('/partner-hunt/preferences')} />
          )}
          {requests.data && (
            <Row icon="handshake-outline" title="Requests & connections" detail={[incoming && `${incoming} waiting for you`, connections && `${connections} connected`].filter(Boolean).join(' · ') || 'Nothing yet'} badge={incoming || undefined} onPress={go({ pathname: '/partner-hunt/connect/[id]', params: { id: 'all' } })} />
          )}
          <Text style={styles.small}>Cards show a first name and initial, an age band and what you share. Nobody sees your photo or full name until you’ve both accepted.</Text>
        </View>
      )}
    </Screen>
  );
}

function Row({ icon, title, detail, badge, onPress }: { icon: React.ComponentProps<typeof Icon>['name']; title: string; detail: string; badge?: number; onPress: () => void }) {
  return (
    <PressScale onPress={onPress} style={styles.row} scaleTo={0.98} accessibilityRole="button" accessibilityLabel={`${title}. ${detail}`}>
      <Icon name={icon} size={22} color={colors.primary} />
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowDetail}>{detail}</Text>
      </View>
      {badge ? <Text style={styles.badge}>{badge}</Text> : null}
      <Icon name="chevron-right" size={20} color={colors.dim} />
    </PressScale>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 14 },
  rowTitle: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 16, letterSpacing: 0.6, textTransform: 'uppercase' },
  rowDetail: { color: colors.dim, fontFamily: fonts.medium, fontSize: 13, marginTop: 2 },
  badge: { color: colors.onPrimary, backgroundColor: colors.primary, fontFamily: fonts.labelBold, fontSize: 13, minWidth: 24, textAlign: 'center', borderRadius: 12, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden' },
  small: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, marginTop: 4 },
});
