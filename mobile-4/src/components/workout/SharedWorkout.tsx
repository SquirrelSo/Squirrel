/**
 * Shared workout — presentational pieces. Every view is driven by props (the server's session
 * state + your own rep count), so the live screen and the design preview render the same UI.
 * "Invite your workout buddy → get ready → start together → see each other's reps live."
 */
import { useEffect, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { copyToClipboard, shareOrCopy } from '@/logic/share';
import type { PersonLite } from '@/api/campus/types';
import { clock, MAX_PENDING_INVITES, SHARED_RACE_XP, type RaceResult, type WorkoutInvite, type WorkoutParticipant } from '@/logic/sharedWorkout';
import { PersonAvatar } from '@/components/campus/PersonAvatar';
import type { Connection } from '@/hooks/useSharedWorkout';
import { Button, Card, Display, FadeIn, Icon, NATIVE, PressScale, ProgressBar, Pulse, tap } from '@/components/ui';
import { useApp } from '@/state/AppState';
import { alpha, colors, fonts, radius } from '@/theme';

export function SharedTag({ status }: { status?: string }) {
  return (
    <View style={styles.tag} accessibilityLabel={`Shared workout${status ? `, ${status}` : ''}`}>
      <Icon name="account-multiple" size={13} color={colors.secondary} />
      <Text style={styles.tagText}>Shared workout{status ? ` · ${status}` : ''}</Text>
    </View>
  );
}

export function ExerciseHeader({ name, blurb, plan, icon }: { name: string; blurb?: string; plan?: string; icon?: React.ComponentProps<typeof Icon>['name'] }) {
  return (
    <Card style={styles.exCard}>
      <View style={styles.exIcon}>
        <Icon name={icon ?? 'arm-flex'} size={26} color={colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.exName}>{name}</Text>
        {!!plan && <Text style={styles.exPlan}>{plan}</Text>}
        {!!blurb && <Text style={styles.exBlurb}>{blurb}</Text>}
      </View>
    </Card>
  );
}

/** Invite link with Share (native sheet) and Copy; plus the "waiting for partner" pulse. */
export function InvitePanel({ url, code, exerciseName }: { url: string; code: string; exerciseName: string }) {
  const { toast } = useApp();
  const message = `Work out with me on Squirrel Social — ${exerciseName}, together. Join: ${url}`;
  const share = () => { tap(); void shareOrCopy({ title: 'Squirrel Social Workout', message, url, toast, copyLabel: 'Invite link' }); };
  const copy = () => { tap(); void copyToClipboard(url, 'Invite link', toast); };
  return (
    <View style={{ gap: 10 }}>
      <Text style={styles.label}>Invite your workout buddy</Text>
      <View style={styles.link} accessibilityLabel={`Invite link ${url}`}>
        <Icon name="link-variant" size={16} color={colors.dim} />
        <Text style={styles.linkText} numberOfLines={1} selectable>{url}</Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button label="Share link" iconLeft="share-variant" size="md" onPress={share} style={{ flex: 1 }} />
        <Button label="Copy" iconLeft="content-copy" size="md" variant="secondary" onPress={copy} style={{ flex: 1 }} />
      </View>
      <Text style={styles.fine}>Code {code} · the invite runs out after 10 minutes if nobody joins.</Text>
    </View>
  );
}

export function WaitingForPartner() {
  return (
    <View style={styles.waiting} accessibilityLiveRegion="polite" accessibilityLabel="Waiting for your partner to join">
      <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: colors.secondary }}>
        <Pulse size={12} color={colors.secondary} />
      </View>
      <Text style={styles.waitingText}>Waiting for your partner to join…</Text>
    </View>
  );
}

/** One of your Partner Hunt buddies, as the invite list shows them. */
export type InvitableBuddy = { profileId: string; name: string };
/** Your buddies with an Invite button each; who's invited or said no comes from the session. */
export function BuddyInvites({ buddies, statusOf, busyId, pending, onInvite }: { buddies: InvitableBuddy[]; statusOf: (profileId: string) => WorkoutInvite['status'] | null; busyId: string | null; pending: number; onInvite: (b: InvitableBuddy) => void }) {
  const full = pending >= MAX_PENDING_INVITES;
  return (
    <View style={{ gap: 8 }}>
      {buddies.map((b) => {
        const st = statusOf(b.profileId);
        return (
          <View key={b.profileId} style={styles.buddy} accessibilityLabel={`${b.name}${st === 'invited' ? ', invited' : st === 'declined' ? ', said no' : ''}`}>
            <View style={styles.buddyInitial}>
              <Text style={styles.buddyInitialText}>{b.name.slice(0, 1).toUpperCase()}</Text>
            </View>
            <Text style={styles.buddyName} numberOfLines={1}>{b.name}</Text>
            {st === 'invited' ? (
              <Text style={[styles.buddyState, { color: colors.gold }]}>Invited</Text>
            ) : st === 'declined' ? (
              <Text style={[styles.buddyState, { color: colors.dim }]}>Said no</Text>
            ) : (
              <Button label={busyId === b.profileId ? '…' : 'Invite'} size="sm" disabled={busyId != null || full} onPress={() => onInvite(b)} />
            )}
          </View>
        );
      })}
      <Text style={styles.fine}>They get a notification and join with this session’s code. Up to {MAX_PENDING_INVITES} invitations can wait at once.</Text>
    </View>
  );
}

type Seat = { person: PersonLite | null; label: string; ready: boolean; connected: boolean; left: boolean; joined: boolean };
export const seatOf = (p: WorkoutParticipant | null, label: string): Seat => ({ person: p?.user ?? null, label, ready: !!p?.ready, connected: p ? p.connected : false, left: !!p?.left_at, joined: !!p });

/** YOU / PARTNER with readiness — colour is never the only signal: every state has words + an icon. */
export function Participants({ you, partner }: { you: Seat; partner: Seat }) {
  return (
    <View style={styles.seats}>
      <SeatView seat={you} />
      <Text style={styles.vs}>+</Text>
      <SeatView seat={partner} />
    </View>
  );
}
function SeatView({ seat }: { seat: Seat }) {
  const state = seat.left ? { t: 'Left', icon: 'account-remove' as const, c: colors.coral } : !seat.joined ? { t: 'Not joined yet', icon: 'account-clock' as const, c: colors.dim } : !seat.connected ? { t: 'Offline', icon: 'wifi-off' as const, c: colors.gold } : seat.ready ? { t: 'Ready', icon: 'check-circle' as const, c: colors.primary } : { t: 'Not ready', icon: 'progress-clock' as const, c: colors.dim };
  return (
    <View style={styles.seat} accessibilityLabel={`${seat.label}${seat.person ? `, ${seat.person.display_name}` : ''}: ${state.t}`}>
      {seat.person ? <PersonAvatar person={seat.person} size={58} link={false} ring={seat.ready ? colors.primary : colors.lineHi} /> : <View style={styles.emptySeat}><Icon name="account-question" size={26} color={colors.mute} /></View>}
      <Text style={styles.seatLabel}>{seat.label}</Text>
      <Text style={styles.seatName} numberOfLines={1}>{seat.person?.display_name ?? '—'}</Text>
      <View style={[styles.seatState, { borderColor: alpha(state.c, 0.5) }]}>
        <Icon name={state.icon} size={13} color={state.c} />
        <Text style={[styles.seatStateText, { color: state.c }]}>{state.t}</Text>
      </View>
    </View>
  );
}

export function ReadyButton({ ready, busy, disabled, onToggle }: { ready: boolean; busy: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <View style={{ gap: 6 }}>
      <Button label={busy ? '…' : ready ? 'Ready ✓ · tap to undo' : 'I’m ready'} iconLeft={ready ? undefined : 'check'} variant={ready ? 'secondary' : 'primary'} disabled={busy || disabled} onPress={onToggle} />
      <Text style={[styles.fine, { textAlign: 'center' }]}>It starts when you’re both ready.</Text>
    </View>
  );
}

export function Countdown({ seconds }: { seconds: number }) {
  const [pop] = useState(() => new Animated.Value(0));
  useEffect(() => {
    pop.setValue(0);
    Animated.timing(pop, { toValue: 1, duration: 700, easing: Easing.out(Easing.back(2)), useNativeDriver: NATIVE }).start();
  }, [seconds, pop]);
  return (
    <View style={styles.countWrap} accessibilityLiveRegion="assertive" accessibilityLabel={seconds > 0 ? `Starting in ${seconds}` : 'Go'}>
      <Text style={styles.starting}>Starting together</Text>
      <Animated.Text style={[styles.countNum, { opacity: pop, transform: [{ scale: pop.interpolate({ inputRange: [0, 1], outputRange: [1.6, 1] }) }] }]}>{seconds > 0 ? seconds : 'GO'}</Animated.Text>
    </View>
  );
}

const CONN_UI: Record<Connection, { t: string; c: string; icon: React.ComponentProps<typeof Icon>['name'] }> = {
  connecting: { t: 'Connecting', c: colors.dim, icon: 'access-point' },
  live: { t: 'Live', c: colors.green, icon: 'access-point' },
  reconnecting: { t: 'Reconnecting…', c: colors.gold, icon: 'access-point-network-off' },
  lost: { t: 'Connection lost', c: colors.coral, icon: 'access-point-off' },
};
export function ConnectionPill({ conn }: { conn: Connection }) {
  const u = CONN_UI[conn];
  return (
    <View style={[styles.conn, { borderColor: alpha(u.c, 0.5) }]} accessibilityLabel={`Session ${u.t}`}>
      <Icon name={u.icon} size={13} color={u.c} />
      <Text style={[styles.connText, { color: u.c }]}>{u.t}</Text>
    </View>
  );
}

/** The race: the clock, your reps (you tap them) vs your partner's (from the server). */
export function ActiveShared({ exercise, secondsLeft, myReps, partnerReps, partnerName, partnerLeft, conn, onRep, onUndo, onFinish, onExit }: { exercise: string; secondsLeft: number; myReps: number; partnerReps: number | null; partnerName: string; partnerLeft: boolean; conn: Connection; onRep: () => void; onUndo: () => void; onFinish: () => void; onExit: () => void }) {
  const top = Math.max(10, myReps, partnerReps ?? 0);
  const lead = partnerReps == null ? 0 : myReps - partnerReps;
  const line = partnerLeft ? `${partnerName} left — keep going` : lead > 2 ? 'You’re ahead — keep it up' : lead < -2 ? 'Catch up!' : 'Keep going';
  return (
    <View style={{ gap: 14 }}>
      <View style={styles.activeTop}>
        <SharedTag />
        <ConnectionPill conn={conn} />
      </View>
      <Display size={34} style={{ textAlign: 'center' }}>{exercise}</Display>
      <Text style={[styles.timer, secondsLeft <= 10 && { color: colors.coral }]} accessibilityRole="timer" accessibilityLabel={`${secondsLeft} seconds left`}>{clock(secondsLeft)}</Text>
      <View style={styles.scores}>
        <Score who="You" reps={myReps} color={colors.primary} />
        <Score who={partnerName} reps={partnerReps} color={partnerLeft ? colors.dim : colors.secondary} />
      </View>
      <View style={{ gap: 6 }}>
        <ProgressBar progress={Math.min(1, myReps / top)} color={colors.primary} height={10} />
        {partnerReps != null && <ProgressBar progress={Math.min(1, partnerReps / top)} color={partnerLeft ? colors.dim : colors.secondary} height={6} />}
        <Text style={[styles.fine, { textAlign: 'center' }]}>Most reps when time runs out wins</Text>
      </View>
      <Text style={styles.cheer} accessibilityLiveRegion="polite">{line}</Text>
      <PressScale onPress={onRep} style={styles.repPad} scaleTo={0.96} accessibilityRole="button" accessibilityLabel={`Add a rep. You have ${myReps}`}>
        <Icon name="plus" size={34} color={colors.onPrimary} />
        <Text style={styles.repPadText}>Tap each rep</Text>
      </PressScale>
      <View style={styles.controls}>
        <Pressable onPress={onUndo} disabled={myReps === 0} style={styles.ctl} accessibilityRole="button" accessibilityLabel="Undo one rep">
          <Icon name="undo" size={18} color={myReps === 0 ? colors.mute : colors.text} />
          <Text style={styles.ctlText}>Undo</Text>
        </Pressable>
        <Pressable onPress={onFinish} disabled={myReps === 0} style={styles.ctl} accessibilityRole="button" accessibilityLabel="Finish now">
          <Icon name="flag-checkered" size={18} color={myReps === 0 ? colors.mute : colors.primary} />
          <Text style={styles.ctlText}>Finish</Text>
        </Pressable>
        <Pressable onPress={onExit} style={styles.ctl} accessibilityRole="button" accessibilityLabel="Exit shared workout">
          <Icon name="exit-run" size={18} color={colors.coral} />
          <Text style={styles.ctlText}>Exit</Text>
        </Pressable>
      </View>
    </View>
  );
}
function Score({ who, reps, color }: { who: string; reps: number | null; color: string }) {
  return (
    <View style={styles.score} accessibilityLabel={`${who}: ${reps ?? 'no reps yet'} reps`}>
      <Text style={styles.scoreWho} numberOfLines={1}>{who}</Text>
      <Text style={[styles.scoreNum, { color }]}>{reps ?? '–'}</Text>
    </View>
  );
}

const OUTCOME: Record<RaceResult['outcome'], { title: string; accent: string }> = {
  won: { title: 'You won', accent: 'the race.' },
  lost: { title: 'Close one', accent: 'next time.' },
  draw: { title: 'Dead', accent: 'heat.' },
  solo: { title: 'Race', accent: 'done.' },
};
/**
 * The result: who won by reps (or "waiting for your partner" while they're still racing). `rewarded`
 * is the server's word from workout.session.completed (null when this screen didn't see the race
 * settle): "+XP" only ever shows for true. Nothing here works out XP.
 */
export function SharedResult({ result, partnerName, partnerStillGoing, rewarded, onHome, onAgain }: { result: RaceResult; partnerName: string; partnerStillGoing: boolean; rewarded: boolean | null; onHome: () => void; onAgain: () => void }) {
  const o = partnerStillGoing ? { title: 'You’re', accent: 'done.' } : OUTCOME[result.outcome];
  return (
    <FadeIn style={{ gap: 14 }}>
      <SharedTag status={partnerStillGoing ? 'waiting for result' : 'finished'} />
      <Display size={40}>{o.title} <Text style={{ color: colors.primary }}>{o.accent}</Text></Display>
      <View style={styles.scores}>
        <Score who="Your reps" reps={result.mine} color={colors.primary} />
        <Score who={`${partnerName}'s reps`} reps={result.theirs} color={colors.secondary} />
      </View>
      <Card style={{ gap: 6 }}>
        {partnerStillGoing ? (
          <Text style={styles.fine}>{partnerName} is still racing. The result lands when they finish or time runs out.</Text>
        ) : result.outcome === 'draw' ? (
          <Text style={styles.row}>Level on reps.</Text>
        ) : result.outcome !== 'solo' ? (
          <Text style={styles.row}>{result.outcome === 'won' ? 'You' : partnerName} did more reps.</Text>
        ) : null}
        {rewarded === true ? (
          <View style={styles.xp} accessibilityLabel={`Plus ${SHARED_RACE_XP} XP for finishing`}>
            <Icon name="star-four-points" size={14} color={colors.primary} />
            <Text style={styles.xpText}>+{SHARED_RACE_XP} XP · for finishing</Text>
          </View>
        ) : rewarded === false ? (
          <Text style={styles.fine}>No XP for this one. XP is for finishing a race without leaving, with at least one rep.</Text>
        ) : null}
        <Text style={styles.fine}>Finishing a race (not leaving, at least one rep) earns {SHARED_RACE_XP} XP, up to 3 races a day.</Text>
      </Card>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button label="Home" size="md" variant="secondary" onPress={onHome} style={{ flex: 1 }} />
        <Button label="Race again" size="md" onPress={onAgain} style={{ flex: 1 }} />
      </View>
    </FadeIn>
  );
}

export type EndedKind = 'signed_out' | 'closed' | 'cancelled' | 'you_left' | 'expired' | 'unavailable' | 'connection_lost' | 'already_completed' | 'full' | 'not_found' | 'error';
const ENDED: Record<EndedKind, { icon: React.ComponentProps<typeof Icon>['name']; title: string; body: string; color: string }> = {
  signed_out: { icon: 'account-lock-outline', title: 'Sign in first', body: 'Shared workouts use your account, so your partner sees who they’re racing.', color: colors.dim },
  closed: { icon: 'flag-checkered', title: 'This session ended', body: 'Start a new one any time.', color: colors.dim },
  cancelled: { icon: 'close-circle-outline', title: 'Session cancelled', body: 'The host called it off before the start.', color: colors.dim },
  you_left: { icon: 'exit-run', title: 'You left the race', body: 'Your reps stopped where they were. Start another one any time.', color: colors.dim },
  expired: { icon: 'timer-sand-complete', title: 'This invite ran out', body: 'Nobody started within 10 minutes. Create a new session to try again.', color: colors.dim },
  unavailable: { icon: 'progress-wrench', title: 'Shared workouts aren’t live yet', body: 'Workout-with-a-partner switches on when its backend is ready. You can still train solo.', color: colors.violet },
  connection_lost: { icon: 'access-point-off', title: 'Connection lost', body: 'We couldn’t reach the session for a while. Check your connection and rejoin.', color: colors.coral },
  already_completed: { icon: 'flag-checkered', title: 'This race can’t be joined', body: 'It has already started or finished.', color: colors.dim },
  full: { icon: 'account-multiple-check', title: 'This race is full', body: 'Someone else has already joined.', color: colors.dim },
  not_found: { icon: 'link-variant-off', title: 'Session not found', body: 'The link may be wrong or the session was removed.', color: colors.dim },
  error: { icon: 'alert-circle-outline', title: 'Something went wrong', body: 'We couldn’t load this session.', color: colors.coral },
};
export function SharedEnded({ kind, detail, primary, onPrimary, secondary, onSecondary }: { kind: EndedKind; detail?: string; primary: string; onPrimary: () => void; secondary?: string; onSecondary?: () => void }) {
  const u = ENDED[kind];
  return (
    <FadeIn style={{ alignItems: 'center', gap: 10, paddingTop: 20 }}>
      <View style={[styles.endIcon, { borderColor: alpha(u.color, 0.5), backgroundColor: alpha(u.color, 0.1) }]}>
        <Icon name={u.icon} size={34} color={u.color} />
      </View>
      <Display size={28} style={{ textAlign: 'center' }}>{u.title}</Display>
      <Text style={[styles.fine, { textAlign: 'center', fontSize: 14, lineHeight: 20 }]}>{detail ?? u.body}</Text>
      <Button label={primary} onPress={onPrimary} style={{ alignSelf: 'stretch', marginTop: 10 }} />
      {secondary && onSecondary && <Button label={secondary} variant="secondary" size="md" onPress={onSecondary} style={{ alignSelf: 'stretch' }} />}
    </FadeIn>
  );
}

const styles = StyleSheet.create({
  tag: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', borderWidth: 1, borderColor: alpha(colors.secondary, 0.5), backgroundColor: alpha(colors.secondary, 0.08), borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  tagText: { color: colors.secondary, fontFamily: fonts.labelBold, fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase' },
  exCard: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  exIcon: { width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: alpha(colors.primary, 0.12), borderWidth: 1, borderColor: alpha(colors.primary, 0.4) },
  exName: { color: colors.text, fontFamily: fonts.display, fontSize: 24, letterSpacing: 0.4, textTransform: 'uppercase' },
  exPlan: { color: colors.primary, fontFamily: fonts.labelBold, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' },
  exBlurb: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, marginTop: 2 },
  label: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 15, letterSpacing: 1, textTransform: 'uppercase' },
  link: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.cardHi, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 12, paddingVertical: 11 },
  linkText: { flex: 1, color: colors.sub, fontFamily: fonts.mono, fontSize: 13 },
  fine: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, lineHeight: 17 },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: 10, justifyContent: 'center', paddingVertical: 10 },
  waitingText: { color: colors.sub, fontFamily: fonts.labelBold, fontSize: 15, letterSpacing: 1, textTransform: 'uppercase' },
  seats: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.line, paddingVertical: 16, paddingHorizontal: 8 },
  seat: { flex: 1, alignItems: 'center', gap: 4 },
  emptySeat: { width: 58, height: 58, borderRadius: 29, borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.lineHi, alignItems: 'center', justifyContent: 'center' },
  seatLabel: { color: colors.dim, fontFamily: fonts.label, fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase', marginTop: 4 },
  seatName: { color: colors.text, fontFamily: fonts.bold, fontSize: 14, maxWidth: 130 },
  seatState: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2, marginTop: 2 },
  seatStateText: { fontFamily: fonts.labelBold, fontSize: 12, letterSpacing: 0.8, textTransform: 'uppercase' },
  vs: { color: colors.mute, fontFamily: fonts.display, fontSize: 26 },
  countWrap: { alignItems: 'center', paddingVertical: 30 },
  starting: { color: colors.secondary, fontFamily: fonts.labelBold, fontSize: 16, letterSpacing: 2, textTransform: 'uppercase' },
  countNum: { color: colors.primary, fontFamily: fonts.display, fontSize: 140, lineHeight: 160 },
  timer: { color: colors.text, fontFamily: fonts.display, fontSize: 72, lineHeight: 80, textAlign: 'center' },
  activeTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  conn: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3 },
  connText: { fontFamily: fonts.labelBold, fontSize: 12, letterSpacing: 0.8, textTransform: 'uppercase' },
  scores: { flexDirection: 'row', gap: 10 },
  score: { flex: 1, alignItems: 'center', backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, paddingVertical: 12 },
  scoreWho: { color: colors.dim, fontFamily: fonts.label, fontSize: 13, letterSpacing: 1.2, textTransform: 'uppercase', maxWidth: '90%' },
  scoreNum: { fontFamily: fonts.display, fontSize: 64, lineHeight: 72 },
  cheer: { color: colors.text, fontFamily: fonts.display, fontSize: 22, letterSpacing: 0.6, textTransform: 'uppercase', textAlign: 'center' },
  repPad: { alignItems: 'center', justifyContent: 'center', gap: 4, backgroundColor: colors.primaryFill, borderRadius: radius.xl, paddingVertical: 22 },
  repPadText: { color: colors.onPrimary, fontFamily: fonts.labelBold, fontSize: 16, letterSpacing: 1.4, textTransform: 'uppercase' },
  controls: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  ctl: { flex: 1, alignItems: 'center', gap: 3, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, paddingVertical: 10 },
  ctlText: { color: colors.sub, fontFamily: fonts.label, fontSize: 12, letterSpacing: 0.8, textTransform: 'uppercase' },
  row: { color: colors.text, fontFamily: fonts.semibold, fontSize: 15 },
  rowK: { color: colors.dim, fontFamily: fonts.label, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' },
  buddy: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 12, paddingVertical: 10 },
  buddyInitial: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: alpha(colors.secondary, 0.12), borderWidth: 1, borderColor: alpha(colors.secondary, 0.4) },
  buddyInitialText: { color: colors.secondary, fontFamily: fonts.display, fontSize: 18 },
  buddyName: { flex: 1, color: colors.text, fontFamily: fonts.bold, fontSize: 14 },
  buddyState: { fontFamily: fonts.labelBold, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' },
  xp: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', borderWidth: 1, borderColor: alpha(colors.primary, 0.5), backgroundColor: alpha(colors.primary, 0.1), borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  xpText: { color: colors.primary, fontFamily: fonts.labelBold, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' },
  endIcon: { width: 76, height: 76, borderRadius: 38, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
});
