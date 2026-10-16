/**
 * PARTNER HUNT · THE BOARD — GET …/matches: people who match you both ways, best first, with why.
 * Every refusal (age, XP, preferences, blocks unreachable) is its own state, never an empty list.
 */
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { errorCode, errorText } from '@/api/campus';
import { errorDetail } from '@/api/partnerHunt';
import { BlockerCard, PersonCard } from '@/components/partnerHunt/Parts';
import { LoadingRows } from '@/components/campus/States';
import { Display, EmptyState, FadeIn, Header, Kicker, Screen, tap } from '@/components/ui';
import { usePartnerMatches, usePartnerStatus } from '@/hooks/usePartnerHunt';
import { boardBlocker } from '@/logic/partnerHunt';
import { colors, fonts } from '@/theme';

export default function Matching() {
  const board = usePartnerMatches();
  const status = usePartnerStatus();
  const blocker = !board.data && board.cause ? boardBlocker(errorCode(board.cause), errorDetail(board.cause), errorText(board.cause)) : null;
  return (
    <Screen tabBar={false}>
      <Header back title="" />
      <Kicker>Partner Hunt</Kicker>
      <Display size={38} style={{ marginTop: 4 }}>Your board</Display>
      <View style={{ gap: 10, marginTop: 16 }}>
        {blocker ? (
          <BlockerCard blocker={blocker} onRetry={board.reload} />
        ) : !board.data ? (
          <LoadingRows rows={4} height={84} />
        ) : !board.data.length ? (
          <EmptyState title="Nobody yet" body="No one matches you both ways right now. Widen your times or activities, or check back as more people join." action="Edit preferences" onAction={() => router.push('/partner-hunt/preferences')} />
        ) : (
          board.data.map((c, i) => (
            <FadeIn key={c.card_id} index={i}>
              <PersonCard card={c} options={status.data?.options} onPress={() => { tap(); router.push({ pathname: '/partner-hunt/buddy/[id]', params: { id: c.card_id } }); }} />
              {c.reasons.length > 0 && <Text style={styles.reasons} numberOfLines={2}>{c.reasons.join(' · ')}</Text>}
            </FadeIn>
          ))
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  reasons: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, marginTop: 4, marginHorizontal: 4 },
});
