/**
 * JOIN A SHARED WORKOUT — where an invite link lands (squirrelsocial://workout/join/{code}, or
 * /w/{code} on the web). Shows who invited you and the exercise, then Join → the session, or
 * Decline (POST …/invites/{code}/decline, 204): the host isn't notified, but their lobby shows it.
 * Someone who opened a shared link without being invited has nothing to decline (404): they just leave.
 */
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { errorKind, errorText, featureUnavailable } from '@/api/campus';
import { useAuth } from '@/auth/AuthProvider';
import { existingSessionId, sharedWorkoutApi, sharedWorkoutErrorCode } from '@/api/sharedWorkout';
import { LoadingRows, NotLiveYet } from '@/components/campus/States';
import { ExerciseHeader, Participants, seatOf, SharedEnded, SharedTag, type EndedKind } from '@/components/workout/SharedWorkout';
import { Button, Display, Header, Screen, tap } from '@/components/ui';
import { EXERCISE_LIBRARY } from '@/data/exercises';
import { useMe } from '@/hooks/useCampus';
import { durationLabel, livePhase, type SharedWorkoutSession } from '@/logic/sharedWorkout';
import { useApp } from '@/state/AppState';
import { colors } from '@/theme';

export default function JoinSharedWorkout() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const { mode } = useAuth();
  const signedIn = mode === 'live';
  const me = useMe();
  const { toast } = useApp();
  const [s, setS] = useState<SharedWorkoutSession | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [joining, setJoining] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [declineNotLive, setDeclineNotLive] = useState(false);
  const [refused, setRefused] = useState<EndedKind | null>(null);
  const home = () => router.replace('/home');
  const leave = () => (router.canGoBack() ? router.back() : home());

  // Wait for the saved token: an invite link often cold-starts the app.
  useEffect(() => {
    if (!signedIn) return;
    let off = false;
    sharedWorkoutApi.previewInvite(code).then((x) => !off && setS(x), (e) => !off && setError(e));
    return () => {
      off = true;
    };
  }, [code, signedIn]);

  // Already part of it (e.g. the host opened their own link): go straight in.
  const mine = !!s?.you;
  useEffect(() => {
    if (mine && s) router.replace({ pathname: '/workout/[id]', params: { id: s.session_id } });
  }, [mine, s]);

  const join = async () => {
    tap('impact');
    setJoining(true);
    try {
      const joined = await sharedWorkoutApi.join(code);
      router.replace({ pathname: '/workout/[id]', params: { id: joined.session_id } });
    } catch (e) {
      setJoining(false);
      const existing = existingSessionId(e);
      if (existing) {
        toast('You’re already in a shared workout', 'account-multiple', colors.gold);
        router.replace({ pathname: '/workout/[id]', params: { id: existing } });
        return;
      }
      const code = sharedWorkoutErrorCode(e);
      if (code === 'session_full') return setRefused('full');
      if (code === 'not_joinable') return setRefused('already_completed');
      if (errorKind(e) === 'not_found') return setRefused('not_found');
      toast(errorText(e), 'alert-circle-outline', colors.coral);
    }
  };

  const decline = async () => {
    tap();
    setDeclining(true);
    try {
      await sharedWorkoutApi.declineInvite(code);
      toast('Declined. They won’t get a notification.', 'close-circle-outline', colors.dim);
      leave();
    } catch (e) {
      setDeclining(false);
      if (featureUnavailable(e)) return setDeclineNotLive(true);
      // 404: you weren't invited (a shared link), so there's nothing to say no to. Just go.
      if (errorKind(e) === 'not_found') return leave();
      toast(errorText(e), 'alert-circle-outline', colors.coral);
    }
  };

  const ex = s ? EXERCISE_LIBRARY.find((e) => e.key === s.exercise.key) : undefined;
  const host = s?.host.user.display_name.split(' ')[0] ?? 'Someone';
  // The preview's phase, ticked at expires_at (a link opened just as it runs out).
  const phase = s ? livePhase(s, Date.parse(s.server_time)) : null;

  return (
    <Screen tabBar={false}>
      <Header back title="" />
      {mode === 'signed-out' || mode === 'demo' ? (
        <SharedEnded kind="signed_out" primary="Sign in" onPrimary={() => router.push('/sign-in')} secondary="Back to Home" onSecondary={home} />
      ) : error ? (
        <SharedEnded kind={featureUnavailable(error) ? 'unavailable' : errorKind(error) === 'not_found' ? 'not_found' : 'error'} detail={featureUnavailable(error) || errorKind(error) === 'not_found' ? undefined : errorText(error)} primary="Back to Home" onPrimary={home} />
      ) : refused ? (
        <SharedEnded kind={refused} primary="Back to Home" onPrimary={home} />
      ) : !s || mine ? (
        <LoadingRows rows={3} height={84} />
      ) : phase === 'expired' ? (
        <SharedEnded kind="expired" primary="Back to Home" onPrimary={home} />
      ) : phase !== 'lobby' ? (
        <SharedEnded kind="already_completed" primary="Back to Home" onPrimary={home} />
      ) : s.partner ? (
        <SharedEnded kind="full" primary="Back to Home" onPrimary={home} />
      ) : (
        <View style={{ gap: 16 }}>
          <SharedTag status="invite" />
          <Display size={36}>{host} wants to{'\n'}work out with you</Display>
          <ExerciseHeader name={s.exercise.name} icon={ex?.icon} blurb={ex?.blurb} plan={`${durationLabel(s.duration_s)} race · most reps wins`} />
          <Participants you={{ ...seatOf(null, 'You'), person: me.data ?? null }} partner={{ ...seatOf(s.host, 'Host') }} />
          <Button label={joining ? 'Joining…' : 'Join workout'} icon="arrow-right" disabled={joining || declining} onPress={join} />
          {declineNotLive ? (
            <NotLiveYet compact name="Declining an invite" body="Saying no switches on when its backend is ready. You can simply ignore the invite: it runs out after 10 minutes." />
          ) : (
            <Button label={declining ? 'Declining…' : 'Decline'} variant="secondary" size="md" disabled={joining || declining} onPress={decline} />
          )}
        </View>
      )}
    </Screen>
  );
}
