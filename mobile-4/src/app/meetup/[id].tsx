/**
 * MEETUP. Answer the invite (accept / decline with Undo / leave; the host cancels), see who's coming,
 * check in, and optionally ask the backend to notify your safety contact. We only say a notification
 * was sent when the API returns status "sent". What you can do is campus-service's rule
 * (logic/meetups meetupActions); a decline waits DECLINE_UNDO_MS before it's sent, so Undo never
 * needs the server (once sent, only the host is told; a declined guest can still accept later).
 */
import { useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Mascot } from '@/art/Mascot';
import { campusApi, CAMPUS_MAP_ON_SERVICE, errorText, isEndpointAvailable, type CheckInResult, type Meetup } from '@/api/campus';
import type { MeetupAction } from '@/api/campus/types';
import { PersonAvatar } from '@/components/campus/PersonAvatar';
import { MeetupRating } from '@/components/meetup/MeetupRating';
import { ErrorState, LoadingRows, SourceBadge } from '@/components/campus/States';
import { Button, Card, Display, Header, Icon, Kicker, Screen, SectionHeader, tap } from '@/components/ui';
import { formatEventDate } from '@/logic/format';
import { invalidateCampus, useAction, useCampus, useConfig, useMe } from '@/hooks/useCampus';
import { colors, fonts, radius } from '@/theme';
import { checkInOpen, DECLINE_UNDO_MS, meetupActions } from '@/logic/meetups';
import { useApp } from '@/state/AppState';

const SAFETY_TEXT: Record<CheckInResult['safety_notification']['status'], string> = {
  sent: 'Your safety contact was notified.',
  failed: 'We couldn’t notify your safety contact. Let them know yourself.',
  not_configured: 'No safety contact is set up, so nobody was notified.',
  skipped: 'You chose not to notify anyone.',
};

export default function MeetupScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const r = useCampus<Meetup>(`meetup:${id}`, () => campusApi.meetup(id));
  const me = useMe();
  const config = useConfig();
  const [notify, setNotify] = useState(true);
  const [openedAt] = useState(() => Date.now());
  const check = useAction((n: boolean) => campusApi.checkIn(id, n));
  const respond = useAction((a: MeetupAction) => campusApi.respondMeetup(id, a));
  const { toast } = useApp();
  const [confirm, setConfirm] = useState<MeetupAction | null>(null);
  const m = r.data;
  const safetyOn = !!config.data?.features.meetup_safety_notifications;
  const checkInLive = !CAMPUS_MAP_ON_SERVICE || isEndpointAvailable('meetupCheckIn');

  if (!m) {
    return (
      <Screen tabBar={false}>
        <Header back title="Meetup" />
        {r.error ? <ErrorState cause={r.cause} onRetry={r.reload} /> : <LoadingRows rows={3} height={90} />}
      </Screen>
    );
  }
  const open = checkInOpen(m);
  const done = check.data ?? (m.my_check_in_at ? null : undefined);
  const checkedIn = !!check.data || !!m.my_check_in_at;
  const actions = meetupActions(m);
  const cancelled = m.status === 'cancelled';
  const declined = m.my_rsvp === 'declined';
  const host = m.attendees.find((a) => a.host);
  const act = async (a: MeetupAction) => {
    // Leaving and cancelling take a second tap.
    if ((a === 'leave' || a === 'cancel') && confirm !== a) {
      tap();
      setConfirm(a);
      return;
    }
    setConfirm(null);
    tap('impact');
    const res = await respond.run(a);
    if (!res) return;
    r.mutate(res);
    invalidateCampus('meetup');
    toast(a === 'accept' ? 'You’re going' : a === 'leave' ? 'You left the meetup' : 'Meetup cancelled', a === 'accept' ? 'check-circle' : 'close-circle', a === 'accept' ? colors.primary : colors.dim);
  };
  // Decline isn't sent until the Undo window has passed: Undo just stops it, nothing to reverse.
  const decline = () => {
    tap();
    const send = setTimeout(async () => {
      try {
        await campusApi.respondMeetup(id, 'decline');
        invalidateCampus('meetup');
      } catch (e) {
        toast(`Couldn’t decline: ${errorText(e)}`, 'alert-circle-outline', colors.coral);
      }
    }, DECLINE_UNDO_MS);
    toast('Invite declined', 'close-circle', colors.dim, { ms: DECLINE_UNDO_MS, action: { label: 'Undo', onPress: () => { clearTimeout(send); toast('Still invited', 'undo', colors.primary); } } });
    if (router.canGoBack()) router.back();
  };
  const doCheckIn = async () => {
    tap('impact');
    const res = await check.run(safetyOn && notify && !!me.data?.safety_contact_configured);
    if (res) {
      tap('success');
      invalidateCampus('meetup');
      r.reload();
    }
  };

  return (
    <Screen tabBar={false}>
      <Header back title="Meetup" right={<SourceBadge />} />
      <Kicker>{formatEventDate(m.starts_at)}</Kicker>
      <Display size={34} style={{ marginTop: 4 }}>{m.title}</Display>
      <Text
        style={[styles.meta, m.location.zone_id && { textDecorationLine: 'underline' }]}
        onPress={m.location.zone_id ? () => router.push({ pathname: '/zone/[id]', params: { id: m.location.zone_id! } }) : undefined}>
        <Icon name="map-marker" size={13} color={colors.primary} /> {m.location.name}
      </Text>

      {cancelled ? (
        <Card style={[styles.rsvp, { borderColor: colors.coral }]}>
          <Text style={[styles.label, { color: colors.coral }]}>This meetup was cancelled</Text>
        </Card>
      ) : actions.length > 0 ? (
        <Card style={styles.rsvp}>
          <Text style={styles.label}>
            {m.my_role === 'host' ? 'You’re hosting' : m.my_rsvp === 'invited' ? `${host?.display_name.split(' ')[0] ?? 'Someone'} invited you` : declined ? 'You declined' : 'You’re going'}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {actions.includes('accept') && <Button label={declined ? 'Join after all' : 'Accept'} iconLeft="check" size="md" disabled={respond.status === 'loading'} onPress={() => act('accept')} style={{ flex: 1 }} />}
            {actions.includes('decline') && <Button label="Decline" variant="secondary" size="md" disabled={respond.status === 'loading'} onPress={decline} style={{ flex: 1 }} />}
            {actions.includes('leave') && <Button label={confirm === 'leave' ? 'Tap again to leave' : 'Leave meetup'} variant="secondary" size="md" disabled={respond.status === 'loading'} onPress={() => act('leave')} style={{ flex: 1 }} />}
            {actions.includes('cancel') && <Button label={confirm === 'cancel' ? 'Tap again to cancel it' : 'Cancel meetup'} variant="secondary" size="md" disabled={respond.status === 'loading'} onPress={() => act('cancel')} style={{ flex: 1 }} />}
          </View>
          {respond.status === 'error' && <Text style={styles.err}>{errorText(respond.error)}</Text>}
        </Card>
      ) : null}

      {cancelled || declined ? null : checkedIn ? (
        <Card style={styles.done}>
          <Mascot pose="celebrate" size={96} animated />
          <Text style={styles.doneTitle}>{openedAt > Date.parse(m.check_in_closes_at) ? 'You checked in' : 'You’re checked in'}</Text>
          <Text style={styles.body}>{new Date(check.data?.checked_in_at ?? m.my_check_in_at!).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · have fun, move safe.</Text>
          {check.data && (
            <View style={[styles.safety, { borderColor: check.data.safety_notification.status === 'sent' ? colors.green : check.data.safety_notification.status === 'failed' ? colors.coral : colors.line }]}>
              <Icon
                name={check.data.safety_notification.status === 'sent' ? 'shield-check' : check.data.safety_notification.status === 'failed' ? 'shield-alert' : 'shield-outline'}
                size={18}
                color={check.data.safety_notification.status === 'sent' ? colors.green : check.data.safety_notification.status === 'failed' ? colors.coral : colors.dim}
              />
              <Text style={styles.safetyText}>
                {SAFETY_TEXT[check.data.safety_notification.status]}
                {check.data.safety_notification.status === 'sent' && check.data.safety_notification.contact_label ? ` Sent to ${check.data.safety_notification.contact_label}.` : ''}
              </Text>
            </View>
          )}
        </Card>
      ) : (
        <Card style={{ marginTop: 14, gap: 12 }}>
          {safetyOn && checkInLive && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Icon name="shield-account" size={22} color={colors.green} />
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Notify my safety contact</Text>
                <Text style={styles.small}>
                  {me.data?.safety_contact_configured ? 'They get the meetup name, place and time when you check in.' : 'No safety contact set up yet — add one from your profile.'}
                </Text>
              </View>
              <Switch value={notify && !!me.data?.safety_contact_configured} disabled={!me.data?.safety_contact_configured} onValueChange={setNotify} trackColor={{ false: colors.lineHi, true: colors.primaryDeep }} thumbColor={notify ? colors.primary : colors.dim} accessibilityLabel="Notify my safety contact" />
            </View>
          )}
          <Button
            label={!checkInLive ? 'Check-in isn’t live yet' : check.status === 'loading' ? 'Checking in…' : open ? 'Check in' : `Check-in opens ${formatEventDate(m.check_in_opens_at)}`}
            iconLeft="map-marker-check"
            disabled={!checkInLive || !open || check.status === 'loading'}
            onPress={doCheckIn}
          />
          {check.status === 'error' && <Text style={styles.err}>{errorText(check.error)}</Text>}
          {!checkInLive && <Text style={styles.small}>Checking in to this meetup switches on once the campus service supports it.</Text>}
          {checkInLive && done === undefined && !open && <Text style={styles.small}>Check-in closes {formatEventDate(m.check_in_closes_at)}.</Text>}
        </Card>
      )}

      {/* After it's over: rate the people you met (the backend decides when that's possible) */}
      <MeetupRating meetupId={m.id} meId={me.data?.user_id ?? null} />

      {/* No meetup photo: Social stores photos for posts and avatars only. */}

      <SectionHeader title={`Who’s coming · ${m.attendees.length}`} />
      <View style={{ gap: 8 }}>
        {m.attendees.map((a) => (
          <View key={a.user_id} style={styles.row}>
            <PersonAvatar person={a} size={36} />
            <Text style={styles.name}>{a.user_id === me.data?.user_id ? 'You' : a.display_name}</Text>
            {a.host ? <Text style={[styles.status, { color: colors.secondary }]}>Host</Text> : a.rsvp === 'invited' ? <Text style={[styles.status, { color: colors.dim }]}>Invited</Text> : checkInLive && <Text style={[styles.status, { color: a.checked_in ? colors.green : colors.dim }]}>{a.checked_in ? 'Checked in' : 'Not yet'}</Text>}
          </View>
        ))}
        {!m.attendees.length && <Text style={styles.small}>No one else yet.</Text>}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  meta: { color: colors.sub, fontFamily: fonts.medium, fontSize: 14, marginTop: 6 },
  done: { marginTop: 14, alignItems: 'center', gap: 6, borderColor: colors.green },
  doneTitle: { color: colors.green, fontFamily: fonts.labelBold, fontSize: 22, letterSpacing: 1, textTransform: 'uppercase' },
  body: { color: colors.sub, fontFamily: fonts.regular, fontSize: 13, textAlign: 'center' },
  safety: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'stretch', borderWidth: 1.5, borderRadius: radius.md, padding: 10, marginTop: 6 },
  safetyText: { flex: 1, color: colors.sub, fontFamily: fonts.medium, fontSize: 13 },
  label: { color: colors.text, fontFamily: fonts.label, fontSize: 15, letterSpacing: 0.6, textTransform: 'uppercase' },
  small: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, lineHeight: 17 },
  err: { color: colors.coral, fontFamily: fonts.medium, fontSize: 13, textAlign: 'center' },
  rsvp: { marginTop: 14, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: 10 },
  name: { flex: 1, color: colors.text, fontFamily: fonts.semibold, fontSize: 14 },
  status: { fontFamily: fonts.label, fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase' },
});
