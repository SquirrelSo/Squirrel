/**
 * WORKOUT WITH PARTNER — create a shared session for the exercise you picked, choose how long the
 * race runs (1, 3 or 5 minutes), then share the invite from the session screen. Rep-based
 * exercises only: most reps when time runs out wins.
 */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { errorText, featureUnavailable } from '@/api/campus';
import { existingSessionId, sharedWorkoutApi } from '@/api/sharedWorkout';
import { ExerciseHeader, SharedEnded, SharedTag } from '@/components/workout/SharedWorkout';
import { Button, Display, Header, Icon, Screen, Segmented, tap } from '@/components/ui';
import { EXERCISE_LIBRARY } from '@/data/exercises';
import { durationLabel, RACE_DURATIONS_S, type RaceDuration } from '@/logic/sharedWorkout';
import { useApp } from '@/state/AppState';
import { colors, fonts } from '@/theme';

const STEPS: [React.ComponentProps<typeof Icon>['name'], string][] = [
  ['share-variant', 'Invite your workout buddy'],
  ['check-circle-outline', 'Both tap “I’m ready”'],
  ['timer-outline', 'A shared countdown starts you together'],
  ['account-multiple', 'Most reps when time runs out wins'],
];

export default function NewSharedWorkout() {
  const { exercise } = useLocalSearchParams<{ exercise?: string }>();
  const ex = EXERCISE_LIBRARY.find((e) => e.key === exercise);
  const { toast } = useApp();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [duration, setDuration] = useState<RaceDuration>(180);
  const back = () => (router.canGoBack() ? router.back() : router.replace('/home'));

  if (!ex) {
    return (
      <Screen tabBar={false}>
        <Header back title="" />
        <SharedEnded kind="not_found" detail="Pick an exercise first, then choose Workout with partner." primary="Choose an exercise" onPrimary={() => router.replace('/exercise/select')} />
      </Screen>
    );
  }

  const create = async () => {
    tap('impact');
    setCreating(true);
    setError(null);
    try {
      const s = await sharedWorkoutApi.create(ex.key, duration);
      router.replace({ pathname: '/workout/[id]', params: { id: s.session_id } });
    } catch (e) {
      // Already in an unfinished session: that's where you belong.
      const existing = existingSessionId(e);
      if (existing) {
        toast('You’re already in a shared workout', 'account-multiple', colors.gold);
        router.replace({ pathname: '/workout/[id]', params: { id: existing } });
        return;
      }
      setError(e);
      setCreating(false);
    }
  };

  return (
    <Screen tabBar={false}>
      <Header back title="" />
      {error && featureUnavailable(error) ? (
        <SharedEnded kind="unavailable" primary="Train solo instead" onPrimary={() => router.replace('/exercise/select')} secondary="Back" onSecondary={back} />
      ) : (
        <View style={{ gap: 16 }}>
          <SharedTag />
          <Display size={38}>
            Workout with{'\n'}
            <Text style={{ color: colors.primary }}>a partner</Text>
          </Display>
          <ExerciseHeader name={ex.name} blurb={ex.blurb} icon={ex.icon} plan={ex.measure === 'reps' ? `${durationLabel(duration)} race · together` : 'Timed · together'} />
          {ex.measure !== 'reps' ? (
            <Text style={styles.note}>Shared workouts are rep races — pick a rep-based exercise.</Text>
          ) : (
            <View style={{ gap: 10 }}>
              <Text style={styles.label}>Race length</Text>
              <Segmented items={RACE_DURATIONS_S.map(durationLabel)} value={durationLabel(duration)} onChange={(v) => setDuration(RACE_DURATIONS_S.find((d) => durationLabel(d) === v) ?? 180)} />
              {STEPS.map(([icon, text], i) => (
                <View key={text} style={styles.step}>
                  <Text style={styles.stepN}>{i + 1}</Text>
                  <Icon name={icon} size={18} color={colors.secondary} />
                  <Text style={styles.stepText}>{text}</Text>
                </View>
              ))}
            </View>
          )}
          {!!error && <Text style={styles.err}>{errorText(error)}</Text>}
          <Button label={creating ? 'Creating…' : 'Create shared session'} icon="arrow-right" disabled={creating || ex.measure !== 'reps'} onPress={create} />
          <Button label="Train solo instead" variant="ghost" size="md" onPress={() => router.replace('/exercise/select')} />
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  step: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepN: { width: 22, color: colors.mute, fontFamily: fonts.display, fontSize: 20 },
  stepText: { flex: 1, color: colors.sub, fontFamily: fonts.medium, fontSize: 14 },
  note: { color: colors.dim, fontFamily: fonts.regular, fontSize: 13 },
  label: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 14, letterSpacing: 1, textTransform: 'uppercase' },
  err: { color: colors.coral, fontFamily: fonts.medium, fontSize: 13, textAlign: 'center' },
});
