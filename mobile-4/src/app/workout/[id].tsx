/**
 * SHARED WORKOUT SESSION — invite → ready → shared countdown → timed rep race → result.
 * The phase is the server's (Exercise), ticked over locally at its own timestamps; the clock is the
 * server's. Your reps are yours (you tap them) and are reported up; your partner's only ever come
 * from the server. XP is the server's too: finishing a race (not leaving, at least one rep) earns
 * 20 XP, up to 3 races a day, and "+20 XP" shows only when workout.session.completed says you were
 * rewarded. Nothing here calls the solo workout's XP path. The host can invite a Partner Hunt buddy
 * from the lobby, and cancel it before the countdown.
 */
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { isEndpointAvailable } from '@/api/availability';
import { errorKind, errorText, featureUnavailable } from '@/api/campus';
import { sharedWorkoutErrorCode } from '@/api/sharedWorkout';
import { useAuth } from '@/auth/AuthProvider';
import { ActiveShared, BuddyInvites, Countdown, ExerciseHeader, InvitePanel, Participants, ReadyButton, seatOf, SharedEnded, SharedResult, SharedTag, WaitingForPartner, type InvitableBuddy } from '@/components/workout/SharedWorkout';
import { Button, Header, Screen, tap } from '@/components/ui';
import { EmptyNote, ErrorState, LoadingRows, NotLiveYet } from '@/components/campus/States';
import { EXERCISE_LIBRARY } from '@/data/exercises';
import { usePartnerHuntUser, usePartnerRequests } from '@/hooks/usePartnerHunt';
import { useSharedWorkout } from '@/hooks/useSharedWorkout';
import { canCancel, durationLabel, inviteRefusal, inviteStatus, myCompletedResult, partnerLeftMidRace, pendingInvites, raceResult, screenPhase, type ScreenPhase, type SharedWorkoutSession } from '@/logic/sharedWorkout';
import { useApp } from '@/state/AppState';
import { colors, fonts } from '@/theme';

const IN_SESSION = new Set<ScreenPhase>(['waiting', 'lobby', 'countdown', 'racing']);

export default function SharedWorkoutScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { mode } = useAuth();
  const w = useSharedWorkout(id, mode === 'live');
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const [confirmExit, setConfirmExit] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelNotLive, setCancelNotLive] = useState(false);
  const [inviting, setInviting] = useState(false);

  const s = w.session;
  const phase = s ? screenPhase(s, w.serverNow) : null;
  const inSession = !!phase && IN_SESSION.has(phase);
  const lost = w.conn === 'lost' && inSession;
  const ex = s ? EXERCISE_LIBRARY.find((e) => e.key === s.exercise.key) : undefined;
  const partnerName = w.partner?.user.display_name.split(' ')[0] ?? 'Partner';
  const home = () => router.replace('/home');
  const again = () => router.replace({ pathname: '/workout/new', params: { exercise: s?.exercise.key ?? '' } });

  // You left the lobby and someone else is still in it: it's theirs now.
  useEffect(() => {
    if (phase === 'removed') router.replace('/home');
  }, [phase]);

  // Leaving mid-session (back gesture / hardware back) asks first, then tells the server.
  const navigation = useNavigation();
  const inSessionRef = useRef(inSession);
  useEffect(() => {
    inSessionRef.current = inSession;
  });
  useEffect(
    () =>
      navigation.addListener('beforeRemove', (e) => {
        if (!inSessionRef.current) return;
        e.preventDefault();
        tap();
        setConfirmExit(true);
        toast('Tap Exit again to leave the shared workout', 'exit-run', colors.gold);
      }),
    [navigation, toast],
  );

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(errorText(e), 'alert-circle-outline', colors.coral);
    } finally {
      setBusy(false);
    }
  };
  const exit = () => {
    if (!confirmExit) {
      tap();
      setConfirmExit(true);
      toast('Tap Exit again to leave the shared workout', 'exit-run', colors.gold);
      return;
    }
    void run(async () => {
      inSessionRef.current = false;
      await w.leave();
    });
  };
  const addRep = (d: 1 | -1) => {
    if (w.tapRep(d)) tap(d > 0 ? 'impact' : 'select');
  };
  const finish = () =>
    run(async () => {
      await w.finish();
      tap('success');
    });

  // Two taps, like leaving. Only the host, only before the countdown: the lobby closes for both.
  const cancel = () => {
    if (!confirmCancel) {
      tap();
      setConfirmCancel(true);
      return;
    }
    setConfirmCancel(false);
    setBusy(true);
    w.cancel().then(
      () => {
        inSessionRef.current = false;
        setBusy(false);
        tap('success');
      },
      (e) => {
        setBusy(false);
        if (featureUnavailable(e)) return setCancelNotLive(true);
        toast(errorText(e), 'alert-circle-outline', colors.coral);
      },
    );
  };

  const mine = myCompletedResult(s, w.completed);
  const you = seatOf(w.me, 'You');
  const partner = seatOf(w.partner, 'Partner');
  const loadError = w.loadError;

  return (
    <Screen tabBar={false}>
      <Header back title="" />
      {mode === 'signed-out' || mode === 'demo' ? (
        <SharedEnded kind="signed_out" primary="Sign in" onPrimary={() => router.push('/sign-in')} secondary="Back to Home" onSecondary={home} />
      ) : lost ? (
        <SharedEnded kind="connection_lost" primary="Try to reconnect" onPrimary={w.reload} secondary="Leave" onSecondary={home} />
      ) : !s ? (
        loadError ? (
          featureUnavailable(loadError) ? (
            <SharedEnded kind="unavailable" primary="Back to Home" onPrimary={home} secondary="Train solo" onSecondary={() => router.replace('/exercise/select')} />
          ) : errorKind(loadError) === 'not_found' ? (
            <SharedEnded kind="not_found" primary="Back to Home" onPrimary={home} />
          ) : (
            <SharedEnded kind="error" detail={errorText(loadError)} primary="Try again" onPrimary={w.reload} secondary="Back to Home" onSecondary={home} />
          )
        ) : (
          <View style={{ gap: 12 }}>
            <SharedTag status="connecting" />
            <LoadingRows rows={3} height={84} />
          </View>
        )
      ) : phase === 'removed' ? (
        <LoadingRows rows={2} height={84} />
      ) : phase === 'expired' ? (
        <SharedEnded kind="expired" primary="New shared session" onPrimary={again} secondary="Back to Home" onSecondary={home} />
      ) : phase === 'cancelled' ? (
        <SharedEnded kind="cancelled" detail={s.you === 'host' ? 'You called it off before the start. Nobody raced.' : undefined} primary="New shared session" onPrimary={again} secondary="Back to Home" onSecondary={home} />
      ) : phase === 'closed' ? (
        <SharedEnded kind="closed" primary="New shared session" onPrimary={again} secondary="Back to Home" onSecondary={home} />
      ) : phase === 'you_left' ? (
        <SharedEnded kind="you_left" primary="Back to Home" onPrimary={home} secondary="New shared session" onSecondary={again} />
      ) : phase === 'result' || phase === 'you_finished' ? (
        <SharedResult result={raceResult(s, w.myReps)} partnerName={partnerName} partnerStillGoing={phase === 'you_finished'} rewarded={phase === 'result' ? (mine?.rewarded ?? (s.you ? s[s.you]?.rewarded : null) ?? null) : null} onHome={home} onAgain={again} />
      ) : phase === 'countdown' ? (
        <View style={{ gap: 14 }}>
          <SharedTag status="starting" />
          <Participants you={you} partner={partner} />
          <Countdown seconds={w.secondsToStart ?? 0} />
        </View>
      ) : phase === 'racing' ? (
        <ActiveShared exercise={s.exercise.name} secondsLeft={w.secondsLeft ?? 0} myReps={w.myReps} partnerReps={w.partner?.reps ?? null} partnerName={partnerName} partnerLeft={partnerLeftMidRace(s)} conn={w.conn} onRep={() => addRep(1)} onUndo={() => addRep(-1)} onFinish={finish} onExit={exit} />
      ) : (
        <View style={{ gap: 16 }}>
          <SharedTag status={phase === 'waiting' ? 'waiting' : 'lobby'} />
          <ExerciseHeader name={s.exercise.name} icon={ex?.icon} blurb={ex?.blurb} plan={`${durationLabel(s.duration_s)} race · most reps wins`} />
          <Participants you={you} partner={partner} />
          {phase === 'waiting' && (
            <>
              <WaitingForPartner />
              <InvitePanel url={s.invite_url} code={s.invite_code} exerciseName={s.exercise.name} />
              {s.you === 'host' &&
                (inviting ? (
                  <InviteBuddiesPanel session={s} onInvite={w.invite} />
                ) : (
                  <Button label="Invite a buddy" iconLeft="account-plus" size="md" variant="secondary" onPress={() => { tap(); setInviting(true); }} />
                ))}
            </>
          )}
          {phase === 'lobby' && <ReadyButton ready={!!w.me?.ready} busy={busy} onToggle={() => run(() => w.setReady(!w.me?.ready))} />}
          {canCancel(s, w.serverNow) && (cancelNotLive ? <NotLiveYet compact name="Cancelling a session" /> : <CancelLink onCancel={busy ? () => undefined : cancel} confirm={confirmCancel} />)}
          <ExitLink onExit={exit} confirm={confirmExit} />
        </View>
      )}
    </Screen>
  );
}

/**
 * The host's Partner Hunt buddies (GET …/partner-hunt/requests → connections), each invitable by
 * the Social profile id the connection carries. Mounted only when opened, so nobody else's lobby
 * asks Partner Hunt for anything.
 */
function InviteBuddiesPanel({ session, onInvite }: { session: SharedWorkoutSession; onInvite: (socialProfileId: string) => Promise<unknown> }) {
  const { userId } = usePartnerHuntUser();
  const requests = usePartnerRequests();
  const { toast } = useApp();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notLive, setNotLive] = useState(false);

  if (!isEndpointAvailable('sharedWorkoutInvites') || notLive) return <NotLiveYet compact name="Workout invites" body="Inviting a buddy switches on when its backend is ready. The link above still works." />;
  if (!userId) return <EmptyNote icon="account-multiple-outline" title="No buddies to invite" body="Your Partner Hunt connections show here once you’re signed in to it." />;
  if (requests.cause && !requests.data) return <ErrorState compact cause={requests.cause} onRetry={requests.reload} />;
  if (!requests.data) return <LoadingRows rows={2} height={56} />;

  const buddies: InvitableBuddy[] = requests.data.connections.map((c) => ({ profileId: c.person.social_profile_id, name: c.person.display_name }));
  if (!buddies.length) return <EmptyNote icon="handshake-outline" title="No buddies yet" body="Connect with someone in Partner Hunt and you can invite them straight from here." action="Open Partner Hunt" onAction={() => router.push('/partner-hunt')} />;

  const invite = async (b: InvitableBuddy) => {
    tap('impact');
    setBusyId(b.profileId);
    try {
      await onInvite(b.profileId);
      toast(`Invited ${b.name}`, 'account-plus', colors.primary);
    } catch (e) {
      if (featureUnavailable(e)) setNotLive(true);
      else toast(inviteRefusal(sharedWorkoutErrorCode(e), errorText(e)), 'alert-circle-outline', colors.coral);
    } finally {
      setBusyId(null);
    }
  };
  return <BuddyInvites buddies={buddies} statusOf={(id) => inviteStatus(session, id)} busyId={busyId} pending={pendingInvites(session)} onInvite={invite} />;
}

/** The host's "cancel" link (two taps): closes the lobby for both before the countdown. */
function CancelLink({ onCancel, confirm }: { onCancel: () => void; confirm: boolean }) {
  return (
    <Text onPress={onCancel} accessibilityRole="button" style={{ alignSelf: 'center', color: confirm ? colors.coral : colors.dim, fontFamily: fonts.medium, fontSize: 13, paddingVertical: 8 }}>
      {confirm ? 'Tap again to cancel it for both of you' : 'Cancel session'}
    </Text>
  );
}

/** A quiet "leave" link under the lobby (two taps, so it's never accidental). */
function ExitLink({ onExit, confirm }: { onExit: () => void; confirm: boolean }) {
  return (
    <Text onPress={onExit} accessibilityRole="button" style={{ alignSelf: 'center', color: confirm ? colors.coral : colors.dim, fontFamily: fonts.medium, fontSize: 13, paddingVertical: 8 }}>
      {confirm ? 'Tap again to leave the session' : 'Leave session'}
    </Text>
  );
}
