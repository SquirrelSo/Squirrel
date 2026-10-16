import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import { EXERCISE_API_CONFIGURED } from '@/api/config';
import { exerciseApi, type ExerciseAvailability } from '@/api/exercise';
import { Sheet } from '@/components/Sheet';
import { Button, Display, Icon, tap } from '@/components/ui';
import { EXERCISE_LIBRARY, estimateKcal, PLAN_BOUNDS, workSeconds, type LibraryExercise } from '@/data/exercises';
import { invalidateExercise, useExerciseCatalog, useExerciseSkill, useExerciseUser } from '@/hooks/useExercise';
import { useApp } from '@/state/AppState';
import { alpha, colors, fonts, radius } from '@/theme';

/**
 * EXERCISE SELECTION: the exercises come from the Exercise backend (GET /api/exercises).
 * Names, icons and blurbs come from the shared library; a catalog id the app doesn't know yet
 * still shows up with a generic card. Start creates a real session
 * (POST /api/users/{id}/sessions) and opens the active exercise.
 */

type Row = { ex: LibraryExercise; avail: ExerciseAvailability };

const titleCase = (id: string) => id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Library entries for each catalog id (variants such as single/double curls become separate rows). */
function rowsFor(catalog: ExerciseAvailability[]): Row[] {
  return catalog
    .flatMap((a) => {
      const lib = EXERCISE_LIBRARY.filter((e) => e.slug === a.id);
      const fallback: LibraryExercise = { key: a.id, slug: a.id, name: titleCase(a.id), bodyPart: 'Full Body', tag: 'Workout', measure: 'reps', icon: 'arm-flex', scene: 'hiit', blurb: 'Form-coached exercise.', met: 4 };
      return (lib.length ? lib : [fallback]).map((ex) => ({ ex, avail: a }));
    })
    .sort((x, y) => Number(y.avail.status === 'enabled') - Number(x.avail.status === 'enabled'));
}

const plan = (ex: LibraryExercise) => ({
  sets: PLAN_BOUNDS.sets.value,
  value: ex.measure === 'reps' ? PLAN_BOUNDS.reps.value : PLAN_BOUNDS.time.value,
  rest: PLAN_BOUNDS.rest.value,
});

export default function SelectExercise() {
  const { height } = useWindowDimensions();
  const { activeExercise, beginExercise, endExercise } = useApp();
  const user = useExerciseUser();
  const catalog = useExerciseCatalog();
  const skill = useExerciseSkill(user?.user_id);
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async (ex: LibraryExercise) => {
    if (starting) return; // one start at a time
    if (!user) {
      router.push('/exercise/profile');
      return;
    }
    const p = plan(ex);
    if (!beginExercise({ key: ex.key })) {
      setError('An exercise is already in progress. Finish or end it first.');
      return;
    }
    tap('impact');
    setStarting(ex.key);
    setError(null);
    try {
      const s = await exerciseApi.createSession(user.user_id, {
        name: ex.name,
        slug: ex.slug,
        ...(ex.variant ? { variant: ex.variant } : {}),
        body_part: ex.bodyPart,
        training_tag: ex.tag,
        measure: ex.measure,
        sets: p.sets,
        value: p.value,
        rest_seconds: p.rest,
      });
      invalidateExercise(user.user_id);
      endExercise(); // hand the guard to the active screen, which re-claims it with the session id
      const target = s.target.type === 'reps' ? s.target.value : Math.round(s.target.value_ms / 1000);
      router.replace({ pathname: '/exercise/train/[key]', params: { key: ex.key, sets: String(s.sets), value: String(target), rest: String(s.rest_seconds), session: s.session_id } });
    } catch (e) {
      endExercise();
      setError(e instanceof Error ? e.message : 'Could not start the exercise.');
      setStarting(null);
    }
  };

  const rows = catalog.data ? rowsFor(catalog.data) : [];

  return (
    <Sheet>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <View style={{ flex: 1 }}>
          <Display size={30}>Start exercise</Display>
          <Text style={styles.sub}>
            Pick one. The coach scores your form.{skill.data ? ` Your level: ${skill.data.skill_level}.` : ''}
          </Text>
        </View>
      </View>

      {activeExercise && (
        <Pressable
          style={styles.active}
          onPress={() => router.replace({ pathname: '/exercise/train/[key]', params: { key: activeExercise.key, session: activeExercise.sessionId ?? '' } })}
          accessibilityLabel="Resume the exercise in progress">
          <Icon name="play-circle" size={20} color={colors.onPrimary} />
          <Text style={styles.activeText}>{EXERCISE_LIBRARY.find((e) => e.key === activeExercise.key)?.name ?? 'Exercise'} in progress · Resume</Text>
        </Pressable>
      )}

      {!EXERCISE_API_CONFIGURED ? (
        <State icon="cloud-off-outline" title="Exercise service not connected" body="Set EXPO_PUBLIC_EXERCISE_API_URL to the Exercise backend and restart the app." />
      ) : catalog.loading && !catalog.data ? (
        <View style={{ gap: 10, marginTop: 14 }}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={[styles.row, { opacity: 0.5 - i * 0.12 }]}>
              <View style={styles.iconBox} />
              <View style={{ flex: 1, gap: 6 }}>
                <View style={styles.skel} />
                <View style={[styles.skel, { width: '60%' }]} />
              </View>
            </View>
          ))}
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : catalog.error && !catalog.data ? (
        <State icon="alert-circle-outline" title="Couldn't load exercises" body={catalog.error} action="Try again" onAction={catalog.reload} />
      ) : rows.length === 0 ? (
        <State icon="playlist-remove" title="No exercises yet" body="The coach hasn't published any exercises. Check back soon." />
      ) : (
        <ScrollView style={{ maxHeight: height * 0.58, marginTop: 12 }} contentContainerStyle={{ gap: 10, paddingBottom: 4 }} showsVerticalScrollIndicator={false}>
          {!user && (
            <View style={styles.note}>
              <Icon name="account-circle-outline" size={18} color={colors.primary} />
              <Text style={[styles.sub, { flex: 1 }]}>Starting an exercise sets up your coach profile first (height & weight for form scoring).</Text>
            </View>
          )}
          {rows.map(({ ex, avail }) => {
            const enabled = avail.status === 'enabled';
            const p = plan(ex);
            const secs = workSeconds(ex, p.sets, p.value);
            const mins = Math.max(1, Math.round((secs + p.rest * (p.sets - 1)) / 60));
            const busy = starting === ex.key;
            const blocked = !!activeExercise || (!!starting && !busy);
            return (
              <View key={ex.key} style={[styles.row, !enabled && { opacity: 0.55 }]}>
                <View style={[styles.iconBox, enabled && { backgroundColor: alpha(colors.primary, 0.12), borderColor: alpha(colors.primary, 0.4) }]}>
                  <Icon name={ex.icon} size={24} color={enabled ? colors.primary : colors.mute} />
                </View>
                <View style={{ flex: 1, marginHorizontal: 12 }}>
                  <Text style={styles.name} numberOfLines={1}>{ex.name}</Text>
                  <Text style={styles.blurb} numberOfLines={2}>{ex.blurb}</Text>
                  {enabled ? (
                    <Text style={styles.meta} numberOfLines={1}>
                      {p.sets} × {ex.measure === 'reps' ? `${p.value} reps` : `${p.value}s`} · ~{mins} min · ~{estimateKcal(ex, secs)} kcal
                    </Text>
                  ) : (
                    <Text style={styles.meta}>Coming soon</Text>
                  )}
                </View>
                {enabled && ex.measure === 'reps' && (
                  <Pressable
                    onPress={() => { tap(); router.replace({ pathname: '/workout/new', params: { exercise: ex.key } }); }}
                    disabled={blocked || busy}
                    style={[styles.partner, (blocked || busy) && { opacity: 0.45 }]}
                    accessibilityRole="button"
                    accessibilityLabel={`Workout with a partner: ${ex.name}`}>
                    <Icon name="account-multiple-plus" size={18} color={colors.secondary} />
                  </Pressable>
                )}
                {enabled ? (
                  <Pressable
                    onPress={() => start(ex)}
                    disabled={blocked || busy}
                    style={[styles.start, (blocked || busy) && { opacity: 0.45 }]}
                    accessibilityRole="button"
                    accessibilityLabel={`Start ${ex.name}`}
                    accessibilityState={{ disabled: blocked || busy, busy }}>
                    {busy ? <ActivityIndicator color={colors.onPrimary} size="small" /> : <Text style={styles.startText}>Start</Text>}
                  </Pressable>
                ) : (
                  <Icon name="lock" size={18} color={colors.mute} />
                )}
              </View>
            );
          })}
          <Text style={[styles.sub, { textAlign: 'center', marginTop: 2 }]}>
            <Text style={{ color: colors.secondary }}>Tap the pink icon to work out with a partner. </Text>
            Default plan: {PLAN_BOUNDS.sets.value} sets · {PLAN_BOUNDS.rest.value}s rest. Calories are estimates.{' '}
            <Text style={{ color: colors.primary }} onPress={() => router.replace('/exercise')}>
              Customise in Form Coach →
            </Text>
          </Text>
        </ScrollView>
      )}
      {error && (
        <View style={[styles.note, { borderColor: alpha(colors.coral, 0.5), marginTop: 10 }]}>
          <Icon name="alert-circle-outline" size={18} color={colors.coral} />
          <Text style={[styles.sub, { flex: 1, color: colors.text }]}>{error}</Text>
        </View>
      )}
    </Sheet>
  );
}

function State({ icon, title, body, action, onAction }: { icon: React.ComponentProps<typeof Icon>['name']; title: string; body: string; action?: string; onAction?: () => void }) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: 24, paddingHorizontal: 12 }}>
      <Icon name={icon} size={34} color={colors.dim} />
      <Text style={[styles.name, { marginTop: 8, textAlign: 'center' }]}>{title}</Text>
      <Text style={[styles.sub, { textAlign: 'center', marginTop: 4 }]}>{body}</Text>
      {action && <Button label={action} size="sm" variant="secondary" onPress={onAction} style={{ marginTop: 12 }} />}
    </View>
  );
}

const styles = StyleSheet.create({
  sub: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 12 },
  iconBox: { width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cardHi, borderWidth: 1, borderColor: colors.line },
  skel: { height: 10, borderRadius: 5, backgroundColor: colors.cardHi, width: '85%' },
  name: { color: colors.text, fontFamily: fonts.bold, fontSize: 15 },
  blurb: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, lineHeight: 16, marginTop: 1 },
  meta: { color: colors.sub, fontFamily: fonts.label, fontSize: 12, letterSpacing: 0.6, textTransform: 'uppercase', marginTop: 5 },
  start: { backgroundColor: colors.primaryFill, borderRadius: radius.pill, paddingHorizontal: 16, paddingVertical: 9, minWidth: 70, alignItems: 'center' },
  partner: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: alpha(colors.secondary, 0.55), backgroundColor: alpha(colors.secondary, 0.08), marginRight: 8 },
  startText: { color: colors.onPrimary, fontFamily: fonts.labelBold, fontSize: 14, letterSpacing: 1, textTransform: 'uppercase' },
  active: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.primary, borderRadius: radius.md, padding: 10, marginTop: 12 },
  activeText: { color: colors.onPrimary, fontFamily: fonts.labelBold, fontSize: 14, letterSpacing: 0.6, textTransform: 'uppercase' },
  note: { flexDirection: 'row', gap: 8, alignItems: 'center', backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: 10 },
});
