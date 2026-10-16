/** CHALLENGE INVITES — incoming / sent, accept · decline · cancel, live status updates. */
import { useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { campusApi, errorText, type ChallengeInvite } from '@/api/campus';
import { PersonAvatar } from '@/components/campus/PersonAvatar';
import { EmptyNote, ErrorState, LoadingRows } from '@/components/campus/States';
import { shortTime } from '@/components/campus/territoryUi';
import { Button, Card, Header, Icon, IconButton, Screen, Segmented, tap } from '@/components/ui';
import { formatEventDate } from '@/logic/format';
import { invalidateCampus, useAction, useCampus, useRealtime, useRefreshOnFocus } from '@/hooks/useCampus';
import { useApp } from '@/state/AppState';
import { colors, fonts, radius } from '@/theme';

const TABS = ['Incoming', 'Sent'] as const;
const STATUS_COLOR: Record<string, string> = { pending: colors.gold, accepted: colors.primary, active: colors.primary, declined: colors.coral, cancelled: colors.dim, expired: colors.dim, completed: colors.blue };

export default function Invites() {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Incoming');
  const box = tab === 'Incoming' ? 'incoming' : 'outgoing';
  const list = useCampus(`invites:${box}`, () => campusApi.invites(box));
  useRefreshOnFocus(list.reload, 30_000);
  useRealtime((m) => {
    if (m.type !== 'invite.updated' || !list.data) return;
    const exists = list.data.some((i) => i.id === m.data.id);
    if (exists) list.mutate(list.data.map((i) => (i.id === m.data.id ? m.data : i)));
    else if (m.data.direction === box) list.mutate([m.data, ...list.data]);
  });
  const items = list.data ?? [];
  return (
    <Screen tabBar={false} scroll={false}>
      <Header back title="Challenges" right={<><IconButton icon="plus" onPress={() => router.push('/invite/new')} label="New challenge" /></>} />
      <Segmented items={TABS} value={tab} onChange={setTab} />
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{ gap: 10, paddingBottom: 40 }}
        renderItem={({ item }) => <InviteCard inv={item} onChanged={(n) => list.data && list.mutate(list.data.map((i) => (i.id === n.id ? n : i)))} />}
        ListEmptyComponent={
          list.signedOut ? (
            <EmptyNote icon="account-lock-outline" title="Sign in to see challenges" action="Sign in" onAction={() => router.push('/sign-in')} />
          ) : list.error ? (
            <ErrorState cause={list.cause} onRetry={list.reload} />
          ) : list.loading ? (
            <LoadingRows rows={3} height={120} />
          ) : (
            <EmptyNote icon="sword-cross" title={tab === 'Incoming' ? 'No challenges for you' : 'You haven’t challenged anyone'} body="Pick a zone, pick a rival, pick a time." action="New challenge" onAction={() => router.push('/invite/new')} />
          )
        }
      />
    </Screen>
  );
}

function InviteCard({ inv, onChanged }: { inv: ChallengeInvite; onChanged: (i: ChallengeInvite) => void }) {
  const { toast } = useApp();
  const act = useAction((a: 'accept' | 'decline' | 'cancel') => campusApi.respondInvite(inv.id, a));
  const respond = async (a: 'accept' | 'decline' | 'cancel') => {
    tap();
    const r = await act.run(a);
    if (r) {
      onChanged(r);
      invalidateCampus('invites');
      toast(a === 'accept' ? 'Challenge accepted — game on' : a === 'decline' ? 'Challenge declined' : 'Challenge cancelled', a === 'accept' ? 'sword-cross' : 'close-circle-outline', a === 'accept' ? colors.primary : colors.dim);
    }
  };
  const other = inv.direction === 'incoming' ? inv.from : inv.target.type === 'user' ? inv.target.person : null;
  const targetName = inv.target.type === 'crew' ? inv.target.crew.name : inv.target.person.display_name;
  const c = STATUS_COLOR[inv.status] ?? colors.dim;
  return (
    <Card style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        {other ? <PersonAvatar person={other} size={42} /> : <View style={styles.crewIcon}><Icon name="account-group" size={20} color={colors.blue} /></View>}
        <View style={{ flex: 1 }}>
          <Text style={styles.type}>{inv.type_label}</Text>
          <Text style={styles.title} numberOfLines={2}>
            {inv.direction === 'incoming' ? `${inv.from.display_name} challenged you` : `You challenged ${targetName}`}
          </Text>
        </View>
        <View style={[styles.status, { borderColor: c }]}>
          <Text style={[styles.statusText, { color: c }]}>{inv.status}</Text>
        </View>
      </View>
      <View style={{ gap: 4 }}>
        {inv.zone && (
          <Text style={styles.meta} onPress={() => router.push({ pathname: '/zone/[id]', params: { id: inv.zone!.id } })}>
            <Icon name="map-marker-radius" size={12} color={colors.primary} /> {inv.zone.name}
          </Text>
        )}
        <Text style={styles.meta}>
          <Icon name="calendar-clock" size={12} color={colors.dim} /> {formatEventDate(inv.starts_at)} · sent {shortTime(inv.created_at)}
        </Text>
        {!!inv.message && <Text style={styles.msg}>“{inv.message}”</Text>}
        {inv.result && <Text style={[styles.msg, { color: colors.primary }]}>{inv.result.summary}</Text>}
      </View>
      {inv.status === 'pending' && (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {inv.direction === 'incoming' ? (
            <>
              <Button label={act.status === 'loading' ? '…' : 'Accept'} iconLeft="check" size="sm" disabled={act.status === 'loading'} onPress={() => respond('accept')} style={{ flex: 1 }} />
              <Button label="Decline" variant="secondary" size="sm" disabled={act.status === 'loading'} onPress={() => respond('decline')} style={{ flex: 1 }} />
            </>
          ) : (
            <Button label={act.status === 'loading' ? 'Cancelling…' : 'Cancel challenge'} variant="secondary" size="sm" disabled={act.status === 'loading'} onPress={() => respond('cancel')} style={{ flex: 1 }} />
          )}
        </View>
      )}
      {act.status === 'error' && <Text style={styles.err}>{errorText(act.error)}</Text>}
    </Card>
  );
}

const styles = StyleSheet.create({
  crewIcon: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cardHi },
  type: { color: colors.secondary, fontFamily: fonts.label, fontSize: 11, letterSpacing: 1, textTransform: 'uppercase' },
  title: { color: colors.text, fontFamily: fonts.bold, fontSize: 15 },
  status: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 },
  statusText: { fontFamily: fonts.label, fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase' },
  meta: { color: colors.dim, fontFamily: fonts.mono, fontSize: 12 },
  msg: { color: colors.sub, fontFamily: fonts.medium, fontSize: 13, fontStyle: 'italic' },
  err: { color: colors.coral, fontFamily: fonts.medium, fontSize: 12 },
});
