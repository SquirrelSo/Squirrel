/**
 * PARTNER HUNT · REQUESTS & CONNECTIONS — GET …/requests. Incoming: accept, or decline (silent: they
 * never learn it); accepting earns you both 20 XP, once per buddy (the server awards it). Outgoing:
 * pending, then expired; withdraw. Connections: open their Social profile, or remove them (silent,
 * then a 30-day wait before either can ask again).
 * `id` is a request_id to highlight (the partner.accepted notification opens /partner-hunt/connect/{id}),
 * or "all".
 */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { errorText } from '@/api/campus';
import { partnerHuntApi, type PartnerConnection, type PartnerRequest } from '@/api/partnerHunt';
import { PersonCard, RemoveBuddy } from '@/components/partnerHunt/Parts';
import { ErrorState, LoadingRows } from '@/components/campus/States';
import { Button, Display, Header, Kicker, Screen, SectionHeader, tap } from '@/components/ui';
import { invalidatePartnerHunt, usePartnerHuntUser, usePartnerRequests, usePartnerStatus } from '@/hooks/usePartnerHunt';
import { formatEventDate } from '@/logic/format';
import { BUDDY_CONNECTED_XP } from '@/logic/partnerHunt';
import { useApp } from '@/state/AppState';
import { alpha, colors, fonts, radius } from '@/theme';

export default function Connect() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = usePartnerHuntUser();
  const requests = usePartnerRequests();
  const status = usePartnerStatus();
  const { toast } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmWithdraw, setConfirmWithdraw] = useState<string | null>(null);
  const opts = status.data?.options;
  const r = requests.data;

  const run = async (requestId: string, fn: () => Promise<unknown>, done: string) => {
    if (!userId) return;
    tap('impact');
    setBusy(requestId);
    try {
      await fn();
      invalidatePartnerHunt();
      toast(done, 'handshake-outline', colors.primary);
    } catch (e) {
      toast(errorText(e), 'alert-circle-outline', colors.coral);
    } finally {
      setBusy(null);
    }
  };
  const withdraw = (q: PartnerRequest) => {
    if (confirmWithdraw !== q.request_id) {
      tap();
      setConfirmWithdraw(q.request_id);
      return;
    }
    setConfirmWithdraw(null);
    void run(q.request_id, () => partnerHuntApi.withdraw(userId!, q.request_id), 'Request withdrawn');
  };
  const open = (c: PartnerConnection) => router.push({ pathname: '/user/[id]', params: { id: c.person.social_profile_id } });
  const hl = (requestId: string) => (requestId === id ? styles.highlight : null);

  return (
    <Screen tabBar={false}>
      <Header back title="" />
      <Kicker>Partner Hunt</Kicker>
      <Display size={34} style={{ marginTop: 4 }}>Requests & connections</Display>
      {!r ? (
        requests.cause ? <ErrorState cause={requests.cause} onRetry={requests.reload} /> : <LoadingRows rows={3} height={84} style={{ marginTop: 16 }} />
      ) : (
        <>
          <SectionHeader title={`Waiting for you · ${r.incoming.length}`} />
          {r.incoming.length ? (
            <View style={{ gap: 10 }}>
              {r.incoming.map((q) => (
                <View key={q.request_id} style={[styles.item, hl(q.request_id)]}>
                  <PersonCard card={q.person} options={opts} />
                  <View style={styles.actions}>
                    <Button label="Accept" iconLeft="check" size="sm" disabled={busy === q.request_id} onPress={() => run(q.request_id, () => partnerHuntApi.accept(userId!, q.request_id), `You and ${q.person.display_name} are connected`)} style={{ flex: 1 }} />
                    <Button label="Decline" variant="secondary" size="sm" disabled={busy === q.request_id} onPress={() => run(q.request_id, () => partnerHuntApi.decline(userId!, q.request_id), 'Declined. They won’t be told.')} style={{ flex: 1 }} />
                  </View>
                </View>
              ))}
            </View>
          ) : (
            <Text style={styles.small}>No one’s asked yet.</Text>
          )}
          {r.incoming.length > 0 && <Text style={[styles.small, { marginTop: 8 }]}>Connecting earns you both {BUDDY_CONNECTED_XP} XP, once per buddy.</Text>}

          <SectionHeader title={`Connected · ${r.connections.length}`} />
          {r.connections.length ? (
            <View style={{ gap: 10 }}>
              {r.connections.map((c) => (
                <View key={c.request_id} style={[styles.item, hl(c.request_id)]}>
                  <PersonCard card={c.person} options={opts} onPress={() => open(c)} right={<Text style={styles.connected}>Connected</Text>} />
                  <Button label="Open their profile" iconLeft="account-circle" size="sm" variant="secondary" onPress={() => open(c)} />
                  {userId && <RemoveBuddy userId={userId} connection={c} />}
                </View>
              ))}
            </View>
          ) : (
            <Text style={styles.small}>When you both say yes, they show here with their real profile.</Text>
          )}

          <SectionHeader title={`You asked · ${r.outgoing.length}`} />
          {r.outgoing.length ? (
            <View style={{ gap: 10 }}>
              {r.outgoing.map((q) => (
                <View key={q.request_id} style={[styles.item, hl(q.request_id)]}>
                  <PersonCard card={q.person} options={opts} right={<Text style={[styles.connected, { color: q.status === 'expired' ? colors.dim : colors.gold }]}>{q.status === 'expired' ? 'Expired' : 'Pending'}</Text>} />
                  {q.status === 'pending' && (
                    <View style={styles.actions}>
                      <Text style={[styles.small, { flex: 1 }]}>Expires {formatEventDate(q.expires_at)}</Text>
                      <Button label={confirmWithdraw === q.request_id ? 'Tap again to withdraw' : 'Withdraw'} size="sm" variant="ghost" disabled={busy === q.request_id} onPress={() => withdraw(q)} />
                    </View>
                  )}
                </View>
              ))}
            </View>
          ) : (
            <Text style={styles.small}>Ask someone from your board.</Text>
          )}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  item: { gap: 8 },
  highlight: { borderRadius: radius.lg, borderWidth: 1.5, borderColor: colors.primary, padding: 6, backgroundColor: alpha(colors.primary, 0.05) },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  connected: { color: colors.primary, fontFamily: fonts.labelBold, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' },
  small: { color: colors.dim, fontFamily: fonts.regular, fontSize: 13, lineHeight: 18 },
});
