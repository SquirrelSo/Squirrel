/**
 * Territory battles for one zone or one crew (campus-service). Every button is one of the battle's
 * `actions` as the server sent them for you; when your crew role couldn't be checked
 * (`actions_status: crew_role_unavailable`) the card says so and offers a retry instead. When crew
 * battles couldn't be loaded at all (`crew_battles_unavailable`), the section says that rather than
 * "no battles".
 *
 * Live while you watch: campus-service pushes `invite.updated` to every participant when a battle is
 * created or changes (each copy carries that person's own `actions`), and the card updates in place.
 * Without a socket, coming back to the screen refreshes it.
 */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { errorText } from '@/api/campus';
import { battlesApi, BATTLES_CONFIGURED } from '@/api/campus/battles';
import type { ChallengeAction, ChallengeInvite } from '@/api/campus/types';
import { PersonAvatar } from '@/components/campus/PersonAvatar';
import { Button, Card, Icon, PressScale, SectionHeader, tap } from '@/components/ui';
import { invalidateCampus, useAction, useCampus, useRealtime, useRefreshOnFocus } from '@/hooks/useCampus';
import { ACTION_LABEL, applyBattleUpdate, battleHeadline, battlesAtZone, battlesForCrew, orderedActions, startSlots, type BattleList as Battles } from '@/logic/battles';
import { formatEventDate } from '@/logic/format';
import { useApp } from '@/state/AppState';
import { alpha, colors, fonts, radius } from '@/theme';

const STATUS_COLOR: Record<string, string> = { pending: colors.gold, accepted: colors.primary, active: colors.primary, declined: colors.coral, cancelled: colors.dim, expired: colors.dim, completed: colors.blue };
const DONE_TOAST: Record<Exclude<ChallengeAction, 'schedule'>, string> = {
  accept: 'Battle accepted', decline: 'Battle declined', cancel: 'Battle cancelled', start: 'Battle on', complete: 'Battle finished',
};

/** Battles at a zone (`zoneId`) or against a crew (`crewId`). Renders nothing when campus-service isn't configured. */
export function BattleList({ zoneId, crewId, newBattle }: { zoneId?: string; crewId?: string; newBattle?: { label: string; params: Record<string, string> } }) {
  const r = useCampus<Battles>('battles', () => battlesApi.list(), { enabled: BATTLES_CONFIGURED });
  useRefreshOnFocus(r.reload, 30_000);
  useRealtime((m) => {
    if (m.type === 'invite.updated' && m.data?.id && r.data) r.mutate(applyBattleUpdate(r.data, m.data));
  });
  if (!BATTLES_CONFIGURED || r.signedOut) return null;
  const rows = r.data?.invites ?? [];
  const list = zoneId ? battlesAtZone(rows, zoneId) : crewId ? battlesForCrew(rows, crewId) : [];
  // Crew battles were left out (the server couldn't check your crews): say so, never "no battles".
  const crewMissing = r.data?.crewBattlesUnavailable === true;
  const crewNote = <Text style={styles.meta}>Crew battles couldn’t load. <Text style={styles.link} onPress={r.reload}>Try again</Text></Text>;
  const start = newBattle ? () => router.push({ pathname: '/invite/new', params: newBattle.params }) : undefined;
  return (
    <View>
      <SectionHeader title="Battles" action={newBattle?.label} onAction={start} />
      {!r.data ? (
        r.error ? (
          <Text style={styles.meta}>Couldn’t load battles. <Text style={styles.link} onPress={r.reload}>Try again</Text></Text>
        ) : (
          <Text style={styles.meta}>Loading battles…</Text>
        )
      ) : list.length === 0 ? (
        crewMissing ? crewNote : <Text style={styles.meta}>{zoneId ? 'No battles for this zone yet.' : 'No battles against this crew yet.'}</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {list.map((b) => <BattleCard key={b.id} b={b} onRetry={r.reload} />)}
          {crewMissing && crewNote}
        </View>
      )}
    </View>
  );
}

function BattleCard({ b, onRetry }: { b: ChallengeInvite; onRetry: () => void }) {
  const { toast } = useApp();
  const [rescheduling, setRescheduling] = useState(false);
  const act = useAction((action: ChallengeAction, startsAt?: string) =>
    action === 'schedule' ? battlesApi.schedule(b.id, startsAt!) : battlesApi.act(b.id, action),
  );
  const run = async (action: ChallengeAction, startsAt?: string) => {
    tap();
    const done = await act.run(action, startsAt);
    if (!done) return;
    setRescheduling(false);
    invalidateCampus('battles');
    toast(action === 'schedule' ? `Moved to ${formatEventDate(done.starts_at)}` : DONE_TOAST[action], 'sword-cross', colors.primary);
  };
  const actions = orderedActions(b.actions);
  const unavailable = b.actions_status === 'crew_role_unavailable';
  const busy = act.status === 'loading';
  const c = STATUS_COLOR[b.status] ?? colors.dim;
  const face = b.direction === 'incoming' ? b.from : b.target.type === 'user' ? b.target.person : null;
  return (
    <Card style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        {face ? <PersonAvatar person={face} size={40} /> : <View style={styles.crewIcon}><Icon name="account-group" size={20} color={colors.blue} /></View>}
        <View style={{ flex: 1 }}>
          <Text style={styles.type}>{b.type_label}</Text>
          <Text style={styles.title} numberOfLines={2}>{battleHeadline(b)}</Text>
        </View>
        <View style={[styles.status, { borderColor: c }]}>
          <Text style={[styles.statusText, { color: c }]}>{b.status}</Text>
        </View>
      </View>
      <Text style={styles.meta}>
        <Icon name="calendar-clock" size={12} color={colors.dim} /> {formatEventDate(b.starts_at)}
        {b.ends_at ? ` – ${formatEventDate(b.ends_at)}` : ''}
      </Text>
      {!!b.message && <Text style={styles.msg}>“{b.message}”</Text>}
      {b.result && <Text style={[styles.msg, { color: colors.primary }]}>{b.result.summary}</Text>}
      {unavailable && (
        <Text style={styles.meta}>
          Couldn’t check your crew role just now, so some options may be missing. <Text style={styles.link} onPress={onRetry}>Retry</Text>
        </Text>
      )}
      {actions.length > 0 && (
        <View style={styles.actions}>
          {actions.map((a, i) => (
            <Button
              key={a}
              label={ACTION_LABEL[a]}
              size="sm"
              variant={i === 0 && a !== 'cancel' && a !== 'decline' ? 'primary' : 'secondary'}
              disabled={busy}
              onPress={() => (a === 'schedule' ? setRescheduling((v) => !v) : run(a))}
              style={{ flexGrow: 1 }}
            />
          ))}
        </View>
      )}
      {rescheduling && (
        <View style={styles.slots}>
          {startSlots().map((s) => (
            <PressScale key={s.label} onPress={() => run('schedule', s.at.toISOString())} style={styles.slot} scaleTo={0.96} accessibilityRole="button" accessibilityLabel={`Move to ${s.label}`}>
              <Text style={styles.slotText}>{s.label}</Text>
            </PressScale>
          ))}
        </View>
      )}
      {act.status === 'error' && <Text style={styles.err}>{errorText(act.error)}</Text>}
    </Card>
  );
}

const styles = StyleSheet.create({
  crewIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cardHi },
  type: { color: colors.secondary, fontFamily: fonts.label, fontSize: 11, letterSpacing: 1, textTransform: 'uppercase' },
  title: { color: colors.text, fontFamily: fonts.bold, fontSize: 15 },
  status: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 },
  statusText: { fontFamily: fonts.label, fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase' },
  meta: { color: colors.dim, fontFamily: fonts.mono, fontSize: 12, lineHeight: 18 },
  link: { color: colors.primary, fontFamily: fonts.label },
  msg: { color: colors.sub, fontFamily: fonts.medium, fontSize: 13, fontStyle: 'italic' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  slots: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  slot: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: alpha(colors.primary, 0.06) },
  slotText: { color: colors.text, fontFamily: fonts.label, fontSize: 13 },
  err: { color: colors.coral, fontFamily: fonts.medium, fontSize: 12 },
});
