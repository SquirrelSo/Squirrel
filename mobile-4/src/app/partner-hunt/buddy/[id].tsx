/**
 * PARTNER HUNT · ONE CARD — passed in from the board or a request list by its card_id (Exercise has
 * no route for a single card; opened cold, the card is found again in those lists). Connect asks them;
 * Block is a real Social block; once connected, Remove buddy ends it silently. Where you stand with
 * them comes from GET …/requests.
 */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { errorCode, errorText } from '@/api/campus';
import { errorDetail, partnerHuntApi } from '@/api/partnerHunt';
import { PersonCard, RemoveBuddy } from '@/components/partnerHunt/Parts';
import { EmptyNote, LoadingRows } from '@/components/campus/States';
import { Button, Card, Display, Header, Kicker, Screen, tap } from '@/components/ui';
import { invalidatePartnerHunt, usePartnerHuntUser, usePartnerMatches, usePartnerRequests, usePartnerStatus } from '@/hooks/usePartnerHunt';
import { labelsOf, requestOutcome, type RequestOutcome } from '@/logic/partnerHunt';
import { useApp } from '@/state/AppState';
import { cardFor, forgetCard } from '@/state/partnerCards';
import { colors, fonts } from '@/theme';

export default function Buddy() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = usePartnerHuntUser();
  const status = usePartnerStatus();
  const board = usePartnerMatches();
  const requests = usePartnerRequests();
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<RequestOutcome | null>(null);
  const [confirmBlock, setConfirmBlock] = useState(false);

  const r = requests.data;
  const connection = r?.connections.find((c) => c.person.card_id === id);
  const outgoing = r?.outgoing.find((x) => x.person.card_id === id && x.status === 'pending');
  const incoming = r?.incoming.find((x) => x.person.card_id === id);
  const card = board.data?.find((c) => c.card_id === id) ?? cardFor(id) ?? connection?.person ?? outgoing?.person ?? incoming?.person ?? null;
  const reasons: string[] = card && 'reasons' in card && Array.isArray(card.reasons) ? (card.reasons as string[]) : [];
  const opts = status.data?.options;

  const connect = async () => {
    if (!userId) return;
    tap('impact');
    setBusy(true);
    setRefused(null);
    try {
      await partnerHuntApi.sendRequest(userId, id);
      invalidatePartnerHunt();
      toast(`Request sent to ${card?.display_name ?? 'them'}`, 'handshake-outline', colors.primary);
    } catch (e) {
      setRefused(requestOutcome(errorCode(e), errorDetail(e), errorText(e)));
    } finally {
      setBusy(false);
    }
  };
  const block = async () => {
    if (!userId) return;
    if (!confirmBlock) {
      tap();
      setConfirmBlock(true);
      return;
    }
    setBusy(true);
    try {
      await partnerHuntApi.block(userId, id);
      forgetCard(id);
      invalidatePartnerHunt();
      toast('Blocked. You won’t see each other anywhere.', 'cancel', colors.dim);
      router.back();
    } catch (e) {
      setBusy(false);
      setConfirmBlock(false);
      toast(errorText(e), 'alert-circle-outline', colors.coral);
    }
  };

  return (
    <Screen tabBar={false}>
      <Header back title="" />
      <Kicker>Partner Hunt</Kicker>
      {!card ? (
        board.loading || requests.loading ? (
          <LoadingRows rows={2} height={90} style={{ marginTop: 16 }} />
        ) : (
          <EmptyNote icon="account-off-outline" title="Not on your board any more" body="They may have changed their preferences or left Partner Hunt." action="Back to your board" onAction={() => router.replace('/partner-hunt/matching')} />
        )
      ) : (
        <View style={{ gap: 14, marginTop: 6 }}>
          <Display size={36}>{card.display_name}</Display>
          <PersonCard card={card} options={opts} />
          {(card.shared_activities.length > 0 || card.shared_times.length > 0 || card.meet.length > 0) && (
            <Card style={{ gap: 6 }}>
              {card.shared_activities.length > 0 && <Fact k="You both do" v={labelsOf(opts?.activities, card.shared_activities).join(', ')} />}
              {card.shared_times.length > 0 && <Fact k="You both train" v={labelsOf(opts?.times, card.shared_times).join(', ')} />}
              {card.meet.length > 0 && <Fact k="You could meet" v={labelsOf(opts?.modes, card.meet).join(' or ')} />}
              {reasons.map((x) => <Text key={x} style={styles.reason}>· {x}</Text>)}
            </Card>
          )}

          {connection ? (
            <>
              <Button label="Open their profile" iconLeft="account-circle" onPress={() => router.push({ pathname: '/user/[id]', params: { id: connection.person.social_profile_id } })} />
              {userId && <RemoveBuddy userId={userId} connection={connection} />}
            </>
          ) : incoming ? (
            <Button label="They asked you — answer" iconLeft="handshake-outline" onPress={() => router.push({ pathname: '/partner-hunt/connect/[id]', params: { id: incoming.request_id } })} />
          ) : outgoing ? (
            <Card style={{ gap: 4 }}>
              <Text style={styles.sent}>Request sent</Text>
              <Text style={styles.small}>You’ll get a notification if they say yes. If they don’t, it simply expires.</Text>
            </Card>
          ) : (
            <Button label={busy ? '…' : 'Connect'} iconLeft="handshake-outline" disabled={busy} onPress={connect} />
          )}
          {refused && (
            <Card style={{ gap: 8 }}>
              <Text style={styles.refused}>{refused.message}</Text>
              {refused.showRequests && <Button label="See requests" size="sm" variant="secondary" onPress={() => router.push({ pathname: '/partner-hunt/connect/[id]', params: { id: refused.requestId ?? 'all' } })} />}
            </Card>
          )}
          <Text onPress={busy ? undefined : block} accessibilityRole="button" style={[styles.block, confirmBlock && { color: colors.coral }]}>
            {confirmBlock ? 'Tap again to block — everywhere, both ways' : 'Block'}
          </Text>
        </View>
      )}
    </Screen>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <Text style={styles.fact}>
      <Text style={styles.factK}>{k}  </Text>
      {v}
    </Text>
  );
}

const styles = StyleSheet.create({
  fact: { color: colors.text, fontFamily: fonts.semibold, fontSize: 14 },
  factK: { color: colors.dim, fontFamily: fonts.label, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' },
  reason: { color: colors.sub, fontFamily: fonts.regular, fontSize: 13 },
  sent: { color: colors.primary, fontFamily: fonts.labelBold, fontSize: 15, letterSpacing: 0.8, textTransform: 'uppercase' },
  small: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, lineHeight: 17 },
  refused: { color: colors.text, fontFamily: fonts.medium, fontSize: 14 },
  block: { alignSelf: 'center', color: colors.dim, fontFamily: fonts.medium, fontSize: 13, paddingVertical: 10 },
});
