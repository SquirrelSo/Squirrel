import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import { CameraView, useCameraPermissions, type CameraType } from 'expo-camera';
import { Scene } from '@/art/Scene';
import { Mascot } from '@/art/Mascot';
import { PoseSkeleton, squatPose, type Joint } from '@/components/PoseSkeleton';
import { Button, Display, Icon, Ring, tap } from '@/components/ui';
import { estimateKcal, exerciseByKey, PLAN_BOUNDS } from '@/data/exercises';
// Drawn over the camera: the dark palette in both themes.
import { darkColors as colors, fonts, MAX_WIDTH, radius } from '@/theme';
import { useKeepAwake } from 'expo-keep-awake';
import { API_CONFIGURED, EXERCISE_API_URL, POSE_DEBUG } from '@/api/config';
import { xpApi } from '@/api/endpoints';
import { ApiError, getApiToken, refreshApiToken } from '@/api/client';
import { exerciseApi } from '@/api/exercise';
import { invalidateExercise, useExerciseUser } from '@/hooks/useExercise';
import { useApp } from '@/state/AppState';
import { CoachSession, type CoachState, type PoseFrame } from '@/workout/coach';
import { liveView } from '@/workout/liveView';
import { PoseCamera } from '@/workout/tracker/PoseCamera';
import { PoseDebugOverlay } from '@/workout/PoseDebugOverlay';
import { getReadyText } from '@/workout/exerciseProfiles';
import type { TrackerStatus } from '@/workout/tracker/types';

/**
 * WORKOUT. Signed in to the coach: a LIVE workout. The phone tracks the body on-device
 * (workout/tracker: MediaPipe in a WebView, the browser coach's proven tracking) and streams it
 * to the coaching server, which counts reps, scores form and cues (workout/coach.ts). Every set is
 * saved, so reports, history and XP follow.
 *
 * Not signed in, or no coach server configured: the guided demo (clearly labelled, nothing saved).
 *
 * The live workout is the app's active exercise while it is open (home's Resume, the exercise
 * picker's one-at-a-time guard), and on finishing it feeds missions and today's activity
 * (AppState.completeExercise) once; its XP is the server's, for the reps the coach counted.
 */
export default function Train() {
  const user = useExerciseUser();
  return user ? <LiveWorkout userId={user.user_id} /> : <DemoWorkout />;
}

const REP_MS = 2600; // one guided rep: down + up
const KG = 65; // estimate until the coach profile weight is wired in
const MET: Record<string, number> = { squat: 5, bicep_curl: 3.5, high_knee: 8, lunge: 4, plank: 3.3 };

type Cue = { title: string; sub: string; faults: Joint[]; good: boolean };
const CUES: Cue[] = [
  { title: 'Great form! 🔥', sub: 'Keep going!', faults: [], good: true },
  { title: 'Sit back more', sub: 'Hips behind heels', faults: ['hip'], good: false },
  { title: 'Nice depth 💪', sub: 'Thighs to parallel', faults: [], good: true },
  { title: 'Knees out', sub: 'Track over your toes', faults: ['knee', 'knee2'], good: false },
  { title: 'Chest up!', sub: 'Proud posture', faults: [], good: true },
];

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function DemoWorkout() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ key: string; sets?: string; value?: string; rest?: string; session?: string }>();
  const ex = exerciseByKey(String(params.key)) ?? exerciseByKey('squat')!;
  const timed = ex.measure === 'time';
  const sets = Number(params.sets) || PLAN_BOUNDS.sets.value;
  const target = Number(params.value) || (timed ? PLAN_BOUNDS.time.value : 15);
  const rest = Number(params.rest ?? PLAN_BOUNDS.rest.value);

  const [perm, requestPerm] = useCameraPermissions();
  const [facing, setFacing] = useState<CameraType>('front');
  const [camFailed, setCamFailed] = useState(false);
  const [music, setMusic] = useState(true);
  const [sound, setSound] = useState(true);
  const [paused, setPaused] = useState(false);
  const [phase, setPhase] = useState<'work' | 'rest' | 'done'>('work');
  const [set, setSet] = useState(1);
  const [reps, setReps] = useState(0); // reps (or counted lifts for timed sets) this set
  const [totalReps, setTotalReps] = useState(0);
  const [elapsed, setElapsed] = useState(0); // active seconds, whole workout
  const [setElapsedS, setSetElapsedS] = useState(0);
  const [restLeft, setRestLeft] = useState(rest);
  const [depth, setDepth] = useState(0);
  const [cue, setCue] = useState(0);
  const [scores, setScores] = useState<number[]>([]);
  const clock = useRef(0);
  const live = useRef({ set: 1, reps: 0, setSecs: 0, rest: rest });

  useEffect(() => {
    if (perm && !perm.granted && perm.canAskAgain) requestPerm();
  }, [perm, requestPerm]);

  const nextSet = useCallback(() => {
    live.current = { ...live.current, set: live.current.set + 1, reps: 0, setSecs: 0 };
    clock.current = 0;
    setSet(live.current.set);
    setReps(0);
    setSetElapsedS(0);
    setDepth(0);
    setPhase('work');
  }, []);

  /** Called from the timers when a set's target is reached. */
  const finishSet = useCallback(() => {
    tap('success');
    if (live.current.set >= sets) setPhase('done');
    else if (rest > 0) {
      live.current.rest = rest;
      setRestLeft(rest);
      setPhase('rest');
    } else nextSet();
  }, [sets, rest, nextSet]);

  // Animation + rep engine (~30 fps).
  useEffect(() => {
    if (paused || phase !== 'work') return;
    let last = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const prev = clock.current;
      clock.current += now - last;
      last = now;
      const t = (clock.current % REP_MS) / REP_MS;
      setDepth(t < 0.5 ? t * 2 : (1 - t) * 2);
      if (Math.floor(clock.current / REP_MS) > Math.floor(prev / REP_MS)) {
        // a rep just completed
        live.current.reps += 1;
        setReps(live.current.reps);
        setTotalReps((r) => r + 1);
        setCue((c) => (c + 1) % CUES.length);
        setScores((sc) => [...sc, 78 + Math.round(Math.random() * 20)]);
        if (sound) tap('impact');
        if (!timed && live.current.reps >= target) finishSet();
      }
    }, 33);
    return () => clearInterval(id);
  }, [paused, phase, sound, timed, target, finishSet]);

  // Seconds: active time (timed sets finish here) and the rest countdown.
  useEffect(() => {
    if (paused || phase === 'done') return;
    const id = setInterval(() => {
      if (phase === 'work') {
        live.current.setSecs += 1;
        setElapsed((e) => e + 1);
        setSetElapsedS(live.current.setSecs);
        if (timed && live.current.setSecs >= target) finishSet();
      } else {
        live.current.rest -= 1;
        setRestLeft(live.current.rest);
        if (live.current.rest <= 0) nextSet();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [paused, phase, timed, target, finishSet, nextSet]);

  const kcal = (MET[ex.slug] ?? 5) * 3.5 * KG / 200 * (elapsed / 60);
  const bpm = phase === 'work' && !paused ? Math.round(88 + Math.min(40, elapsed / 3) + depth * 6) : Math.round(84 + Math.min(30, elapsed / 5));
  const progress = timed ? setElapsedS / target : reps / target;
  const c = CUES[cue];
  const showCamera = perm?.granted && !camFailed;
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      {/* Background: live camera, or the exercise scene when the camera isn't available */}
      {showCamera ? (
        <CameraView style={StyleSheet.absoluteFill} facing={facing} mirror={facing === 'front'} active={!paused && phase !== 'done'} onMountError={() => setCamFailed(true)} />
      ) : (
        <Scene kind={ex.scene} seed={9} aspect={0.46} style={StyleSheet.absoluteFill} />
      )}
      <LinearGradient colors={['rgba(6,6,6,0.55)', 'rgba(6,6,6,0.05)', 'rgba(6,6,6,0.05)', 'rgba(6,6,6,0.85)']} locations={[0, 0.22, 0.6, 1]} style={StyleSheet.absoluteFill} />

      {/* Body tracking */}
      <View style={[styles.stage, { top: insets.top + 110, bottom: 230 + insets.bottom }]} pointerEvents="none">
        <PoseSkeleton pose={squatPose(phase === 'work' ? depth : 0)} faults={phase === 'work' && depth > 0.6 ? c.faults : []} />
      </View>

      <View style={[styles.col, { paddingTop: insets.top + 10, paddingBottom: insets.bottom + 16 }]} pointerEvents="box-none">
        {/* Top row */}
        <View style={styles.topRow}>
          <View style={styles.counter}>
            <Ring progress={progress} size={62} stroke={6} color={colors.primary}>
              <Icon name={ex.icon} size={24} color={colors.primary} />
            </Ring>
            <View style={{ marginLeft: 12 }}>
              <Text style={styles.exName} numberOfLines={1}>{ex.name}</Text>
              {timed ? (
                <Text style={styles.count}>
                  <Text style={{ color: colors.primary }}>{mmss(setElapsedS)}</Text> / {mmss(target)}
                </Text>
              ) : (
                <Text style={styles.count}>
                  <Text style={{ color: colors.primary }}>{reps}</Text> / {target}
                </Text>
              )}
              <Text style={styles.setText}>Set {set} of {sets}</Text>
            </View>
          </View>
          <View style={{ gap: 12 }}>
            <RoundBtn icon="close" label="End workout" onPress={() => setPaused(true)} />
            <RoundBtn icon={sound ? 'volume-high' : 'volume-off'} label={sound ? 'Mute cues' : 'Unmute cues'} onPress={() => setSound((s) => !s)} />
          </View>
        </View>
        <View style={styles.demoPill}>
          <View style={styles.demoDot} />
          <Text style={styles.demoText}>{showCamera ? 'Camera on · guided tracking (demo)' : 'Guided tracking (demo)'}</Text>
        </View>

        <View style={{ flex: 1 }} />

        {/* Right rail: calories ring + form cue */}
        <View style={styles.rail}>
          <Ring progress={(kcal % 20) / 20} size={112} stroke={9} color={colors.primary}>
            <Text style={{ fontSize: 18 }}>🔥</Text>
            <Text style={styles.kcalBig}>{Math.round(kcal)}</Text>
            <Text style={styles.kcalUnit}>cal</Text>
          </Ring>
          {phase === 'work' && (
            <View style={[styles.cue, !c.good && { borderColor: colors.coral }]}>
              <Text style={[styles.cueTitle, !c.good && { color: colors.coral }]}>{c.title}</Text>
              <Text style={styles.cueSub}>{c.sub}</Text>
            </View>
          )}
        </View>

        {/* Stats bar */}
        <View style={styles.stats}>
          <Stat value={mmss(elapsed)} label="Time" />
          <View style={styles.div} />
          <Stat value={String(bpm)} label="BPM" icon="heart" iconColor={colors.pink} />
          <View style={styles.div} />
          <Stat value={String(Math.round(kcal))} label="Calories" icon="fire" iconColor={colors.orange} />
        </View>

        {/* Controls */}
        <View style={styles.controls}>
          <RoundBtn icon={music ? 'music' : 'music-off'} label="Music" size={64} active={music} onPress={() => setMusic((m) => !m)} />
          <Pressable onPress={() => { tap('impact'); setPaused((p) => !p); }} style={styles.pauseRing} accessibilityLabel={paused ? 'Resume' : 'Pause'}>
            <View style={styles.pauseInner}>
              <Icon name={paused ? 'play' : 'pause'} size={46} color={colors.text} />
            </View>
          </Pressable>
          <RoundBtn icon="camera-flip-outline" label="Flip camera" size={64} onPress={() => (perm?.granted ? setFacing((f) => (f === 'front' ? 'back' : 'front')) : requestPerm())} />
        </View>
      </View>

      {/* Rest between sets */}
      {phase === 'rest' && (
        <View style={styles.overlay}>
          <Text style={styles.kicker}>Set {set} done · rest</Text>
          <Display size={96} color={colors.primary}>{restLeft}</Display>
          <Text style={styles.overlaySub}>Next: set {set + 1} of {sets}</Text>
          <Button label="Skip rest" size="md" onPress={nextSet} style={{ marginTop: 20, alignSelf: 'stretch' }} />
        </View>
      )}

      {/* Paused */}
      {paused && phase !== 'done' && (
        <View style={styles.overlay}>
          <Display size={48}>Paused</Display>
          <Text style={styles.overlaySub}>{totalReps} reps · {mmss(elapsed)} · {Math.round(kcal)} cal</Text>
          <Button label="Resume" icon="play" onPress={() => setPaused(false)} style={{ marginTop: 22, alignSelf: 'stretch' }} />
          <Button label="End workout" variant="secondary" size="md" onPress={() => { setPaused(false); setPhase('done'); }} style={{ marginTop: 10, alignSelf: 'stretch' }} />
        </View>
      )}

      {/* Summary */}
      {phase === 'done' && (
        <View style={styles.overlay}>
          <Mascot pose="celebrate" size={130} animated />
          <Display size={40} style={{ marginTop: 6, textAlign: 'center' }}>Workout done</Display>
          <Text style={styles.overlaySub}>{ex.name}</Text>
          <View style={[styles.stats, { marginTop: 18, alignSelf: 'stretch' }]}>
            <Stat value={String(totalReps)} label={timed ? 'Lifts' : 'Reps'} />
            <View style={styles.div} />
            <Stat value={mmss(elapsed)} label="Time" />
            <View style={styles.div} />
            <Stat value={String(Math.round(kcal))} label="Calories" />
            <View style={styles.div} />
            <Stat value={avg == null ? '—' : String(avg)} label="Form" />
          </View>
          <Text style={[styles.overlaySub, { fontSize: 12, marginTop: 12 }]}>Demo tracking: this workout isn&apos;t scored by the coach or saved.</Text>
          {params.session ? (
            <Button label="View session" icon="arrow-right" onPress={() => router.replace({ pathname: '/exercise/session/[id]', params: { id: String(params.session) } })} style={{ marginTop: 18, alignSelf: 'stretch' }} />
          ) : null}
          <Button label="Done" variant={params.session ? 'secondary' : 'primary'} size="md" onPress={() => (router.canGoBack() ? router.back() : router.replace('/exercise'))} style={{ marginTop: 10, alignSelf: 'stretch' }} />
        </View>
      )}
    </View>
  );
}


// ---------------------------------------------------------------------------------------------
// Live workout
// ---------------------------------------------------------------------------------------------

type LiveSession = { id: string; exercise: string; variant?: string };
/** How long to keep retrying the plan's save while the server is unreachable (waking up). */
const SAVE_RETRY_MS = 90_000;

function LiveWorkout({ userId }: { userId: string }) {
  useKeepAwake();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ key: string; sets?: string; value?: string; rest?: string; session?: string; weight?: string }>();
  const ex = exerciseByKey(String(params.key)) ?? exerciseByKey('squat')!;
  const timed = ex.measure === 'time';
  const sets = Number(params.sets) || PLAN_BOUNDS.sets.value;
  const target = Number(params.value) || (timed ? PLAN_BOUNDS.time.value : 15);
  const rest = Number(params.rest ?? PLAN_BOUNDS.rest.value);
  const weightKg = Number(params.weight) > 0 ? Number(params.weight) : undefined;

  const [perm, requestPerm] = useCameraPermissions();
  const [session, setSession] = useState<LiveSession | null>(
    params.session ? { id: String(params.session), exercise: ex.slug, variant: ex.variant } : null,
  );
  const [setupError, setSetupError] = useState<string | null>(null);
  const [tracker, setTracker] = useState<{ status: TrackerStatus; detail?: string }>({ status: 'loading' });
  const [trackerKey, setTrackerKey] = useState(0);
  const [state, setState] = useState<CoachState | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const coach = useRef<CoachSession | null>(null);
  const { beginExercise, endExercise, completeExercise, syncServerXp } = useApp();
  // XP is the server's (2 per counted rep): the total before the workout, to show what it earned.
  const xpBefore = useRef<number | null>(null);
  const [xpGained, setXpGained] = useState<number | null>(null);
  useEffect(() => {
    if (API_CONFIGURED) xpApi.me().then((r) => { xpBefore.current = r.xp; }).catch(() => {});
  }, []);

  useEffect(() => {
    if (perm && !perm.granted && perm.canAskAgain) requestPerm();
  }, [perm, requestPerm]);

  // The active exercise while this screen is open (the picker may already have marked it).
  useEffect(() => {
    beginExercise({ key: ex.key, sessionId: params.session ? String(params.session) : undefined });
    return () => endExercise();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A workout started without a saved plan saves one now: the server coaches only saved sessions.
  // It runs alongside the get-ready countdown. A server that is waking up (free hosting sleeps)
  // answers nothing for up to a minute, so an unreachable server is retried for up to 90 s.
  useEffect(() => {
    if (session) return;
    let cancelled = false;
    const save = async () => {
      const deadline = Date.now() + SAVE_RETRY_MS;
      for (;;) {
        try {
          const s = await exerciseApi.createSession(userId, {
            name: ex.name, slug: ex.slug, ...(ex.variant ? { variant: ex.variant } : {}), body_part: ex.bodyPart,
            training_tag: ex.tag, measure: ex.measure, sets, value: target, rest_seconds: sets > 1 ? rest : 0,
            ...(weightKg ? { weight_kg: weightKg } : {}),
          });
          if (!cancelled) setSession({ id: s.session_id, exercise: s.exercise_id, variant: s.variant ?? undefined });
          return;
        } catch (e) {
          const unreachable = e instanceof ApiError && e.status === 0;
          if (cancelled) return;
          if (!unreachable || Date.now() + 3000 > deadline) {
            setSetupError(e instanceof Error ? e.message : 'Could not start the workout.');
            return;
          }
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    };
    void save();
    return () => {
      cancelled = true;
    };
  }, [session, userId, ex, sets, target, rest, weightKg]);

  // The coaching session. Server messages arrive ~30 a second; the screen redraws at most ~8 a
  // second, except at once when something structural changes (phase, set, rest, error).
  // Created at once, so the get-ready countdown starts while the plan is still being saved.
  const initialSession = useRef(session);
  useEffect(() => {
    const first = initialSession.current;
    const c = new CoachSession({
      baseUrl: EXERCISE_API_URL, userId, sessionId: first?.id, exercise: first?.exercise ?? ex.slug, variant: first?.variant ?? ex.variant,
      sets, measure: ex.measure, restSeconds: sets > 1 ? rest : 0, getToken: getApiToken, refreshToken: refreshApiToken,
    });
    coach.current = c;
    let shown: CoachState | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const show = (s: CoachState) => {
      shown = s;
      setState(s);
    };
    const unsubscribe = c.subscribe((s) => {
      const structural = !shown || s.phase !== shown.phase || s.set !== shown.set || s.restLeft !== shown.restLeft
        || s.getReadyLeft !== shown.getReadyLeft || s.inView !== shown.inView || s.framing?.kind !== shown.framing?.kind
        || s.error !== shown.error || s.paused !== shown.paused || s.results.length !== shown.results.length;
      if (structural) {
        if (timer) clearTimeout(timer);
        timer = null;
        show(s);
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          show(c.getState());
        }, 120);
      }
      if (s.phase === 'done' && shown?.phase !== 'done') invalidateExercise(userId);
    });
    c.start();
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
      c.dispose();
      coach.current = null;
    };
  }, [userId, sets, rest, ex.measure, ex.slug, ex.variant]);

  useEffect(() => {
    if (session) coach.current?.setSession(session.id, session.exercise, session.variant);
  }, [session]);

  // Workout clock: counts while a set is running.
  const phase = state?.phase ?? 'setup';
  const paused = state?.paused ?? false;
  useEffect(() => {
    if (phase !== 'training' || paused) return;
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [phase, paused]);

  const onFrame = useCallback((f: PoseFrame) => coach.current?.frame(f), []);
  const onStatus = useCallback((status: TrackerStatus, detail?: string) => setTracker({ status, detail }), []);
  const readDebug = useCallback(() => coach.current?.debug() ?? null, []);
  const view = useMemo(() => liveView(state, tracker.status, target, target), [state, tracker.status, target]);

  // Say it when a rep lands.
  const lastCount = useRef(0);
  useEffect(() => {
    if (!view.timed && view.count > lastCount.current) tap('impact');
    lastCount.current = view.count;
  }, [view.count, view.timed]);

  const done = phase === 'done';
  const results = state?.results ?? [];
  const totalCount = results.reduce((a, r) => a + r.count, 0);
  const scored = results.filter((r) => r.score != null);
  const avgScore = scored.length ? Math.round(scored.reduce((a, r) => a + (r.score ?? 0), 0) / scored.length) : null;
  const trackingOn = !done && phase !== 'rest';

  // Finished: missions and today's activity, once. An empty workout records nothing.
  const recorded = useRef(false);
  useEffect(() => {
    if (!done || recorded.current) return;
    recorded.current = true;
    if (totalCount === 0 && (!timed || elapsed < 10)) return;
    completeExercise({
      key: ex.key, slug: ex.slug, reps: timed ? 0 : totalCount, timedSeconds: timed ? elapsed : 0,
      activeSeconds: elapsed, kcal: estimateKcal(ex, elapsed),
    });
    endExercise();
  }, [done, totalCount, timed, elapsed, ex, completeExercise, endExercise]);

  // XP earned: the server's total after the workout, minus before. The coach writes the session's
  // activity row just after the last set, so give it a few seconds.
  useEffect(() => {
    if (!done || !API_CONFIGURED) return;
    let cancelled = false;
    void (async () => {
      for (let attempt = 0; attempt < 5 && !cancelled; attempt++) {
        await new Promise((r) => setTimeout(r, 1500));
        const now = await xpApi.me().catch(() => null);
        if (!now || cancelled) continue;
        const gained = xpBefore.current == null ? null : Math.max(0, now.xp - xpBefore.current);
        if (gained || attempt === 4) {
          syncServerXp(now.xp, gained ?? undefined);
          setXpGained(gained);
          return;
        }
      }
    })();
    return () => { cancelled = true; };
  }, [done, syncServerXp]);
  const cameraReady = !!perm?.granted || Platform.OS === 'web';
  const blocking = setupError ?? (state?.fatal ? state.error?.detail ?? 'The coach stopped this workout.' : null);

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      {cameraReady && !blocking ? (
        <PoseCamera key={trackerKey} active={trackingOn} skeleton={view.skeleton} onFrame={onFrame} onStatus={onStatus} style={StyleSheet.absoluteFill} />
      ) : (
        <Scene kind={ex.scene} seed={9} aspect={0.46} style={StyleSheet.absoluteFill} />
      )}
      <LinearGradient colors={['rgba(6,6,6,0.55)', 'rgba(6,6,6,0)', 'rgba(6,6,6,0)', 'rgba(6,6,6,0.8)']} locations={[0, 0.22, 0.62, 1]} style={StyleSheet.absoluteFill} pointerEvents="none" />

      <View style={[styles.col, { paddingTop: insets.top + 10, paddingBottom: insets.bottom + 16 }]} pointerEvents="box-none">
        <View style={styles.topRow}>
          <View style={styles.counter}>
            <Ring progress={view.capture ?? view.progress} size={62} stroke={6} color={colors.primary}>
              <Icon name={ex.icon} size={24} color={colors.primary} />
            </Ring>
            <View style={{ marginLeft: 12, flexShrink: 1 }}>
              <Text style={styles.exName} numberOfLines={1}>{ex.name}</Text>
              <Text style={styles.count}>
                {view.timed ? (
                  <><Text style={{ color: colors.primary }}>{mmss(phase === 'training' ? view.count : target)}</Text> left</>
                ) : (
                  <><Text style={{ color: colors.primary }}>{phase === 'training' ? view.count : 0}</Text> / {target}</>
                )}
              </Text>
              <Text style={styles.setText}>Set {state?.set ?? 1} of {sets}</Text>
            </View>
          </View>
          <RoundBtn icon="close" label="End workout" onPress={() => setConfirmEnd(true)} />
        </View>
        <View style={styles.demoPill}>
          <View style={[styles.demoDot, view.skeleton === 'red' && { backgroundColor: colors.coral }]} />
          <Text style={styles.demoText} numberOfLines={1}>{view.status}</Text>
        </View>

        <View style={{ flex: 1 }} />

        <View style={styles.rail}>
          {view.cue ? (
            <View style={[styles.cue, view.skeleton === 'red' && { borderColor: colors.coral }]}>
              <Text style={[styles.cueTitle, view.skeleton === 'red' && { color: colors.coral }]}>{view.cue}</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.stats}>
          <Stat value={mmss(elapsed)} label="Time" />
          <View style={styles.div} />
          <Stat value={String(totalCount + (phase === 'training' && !view.timed ? view.count : 0))} label={timed ? 'Lifts' : 'Reps'} />
          <View style={styles.div} />
          <Stat value={view.score == null ? '—' : String(view.score)} label="Form" />
        </View>

        <View style={[styles.controls, { justifyContent: 'center' }]}>
          <Pressable
            onPress={() => { tap('impact'); if (paused) coach.current?.resume(); else coach.current?.pause(); }}
            disabled={phase !== 'training'}
            style={[styles.pauseRing, phase !== 'training' && { opacity: 0.4 }]}
            accessibilityLabel={paused ? 'Resume' : 'Pause'}>
            <View style={styles.pauseInner}>
              <Icon name={paused ? 'play' : 'pause'} size={46} color={colors.text} />
            </View>
          </Pressable>
        </View>
      </View>

      {POSE_DEBUG && <PoseDebugOverlay read={readDebug} delegate={tracker.detail} top={insets.top + 150} />}

      {/* Camera permission, or tracking that could not start */}
      {!blocking && perm && !perm.granted && Platform.OS !== 'web' && (
        <View style={styles.overlay}>
          <Icon name="camera-outline" size={40} color={colors.primary} />
          <Display size={30} style={{ marginTop: 8, textAlign: 'center' }}>Camera needed</Display>
          <Text style={styles.overlaySub}>The coach watches your form through the front camera. Nothing is recorded as video: only body points leave the phone.</Text>
          <Button label={perm.canAskAgain ? 'Allow camera' : 'Open settings'} onPress={() => (perm.canAskAgain ? requestPerm() : Linking.openSettings())} style={{ marginTop: 20, alignSelf: 'stretch' }} />
          <Button label="Back" variant="secondary" size="md" onPress={() => router.back()} style={{ marginTop: 10, alignSelf: 'stretch' }} />
        </View>
      )}
      {!blocking && (tracker.status === 'error' || tracker.status === 'denied') && (
        <View style={styles.overlay}>
          <Icon name="alert-circle-outline" size={40} color={colors.coral} />
          <Display size={28} style={{ marginTop: 8, textAlign: 'center' }}>{tracker.status === 'denied' ? 'Camera blocked' : 'Tracking didn’t start'}</Display>
          <Text style={styles.overlaySub}>{tracker.status === 'denied' ? 'Allow camera access for Squirrel Social, then try again.' : 'Body tracking needs an internet connection the first time it loads.'}</Text>
          <Button label="Try again" icon="refresh" onPress={() => { setTracker({ status: 'loading' }); setTrackerKey((k) => k + 1); }} style={{ marginTop: 20, alignSelf: 'stretch' }} />
          <Button label="Back" variant="secondary" size="md" onPress={() => router.back()} style={{ marginTop: 10, alignSelf: 'stretch' }} />
        </View>
      )}
      {blocking && (
        <View style={styles.overlay}>
          <Icon name="alert-circle-outline" size={40} color={colors.coral} />
          <Display size={28} style={{ marginTop: 8, textAlign: 'center' }}>Workout stopped</Display>
          <Text style={styles.overlaySub}>{blocking}</Text>
          <Button label="Back" onPress={() => router.back()} style={{ marginTop: 20, alignSelf: 'stretch' }} />
        </View>
      )}

      {/* Getting into position: the camera stays visible; the set starts on its own */}
      {phase === 'getready' && view.getReady != null && !blocking && (
        <View style={[styles.getReady, { top: insets.top + 156 }]} pointerEvents="none">
          <Text style={styles.kicker}>Get in position · set {state?.set ?? 1} of {sets}</Text>
          <Display size={56} color={colors.primary}>{view.getReady}</Display>
          <Text style={styles.getReadySub}>{getReadyText(ex.slug, ex.variant)}</Text>
        </View>
      )}

      {/* Rest between sets */}
      {phase === 'rest' && (
        <View style={styles.overlay}>
          <Text style={styles.kicker}>Set {state?.set} done{results.at(-1)?.score != null ? ` · form ${Math.round(results.at(-1)!.score!)}` : ''} · rest</Text>
          <Display size={96} color={colors.primary}>{state?.restLeft ?? 0}</Display>
          <Text style={styles.overlaySub}>Next: set {(state?.set ?? 1) + 1} of {sets}</Text>
          <Button label="Skip rest" size="md" onPress={() => coach.current?.skipRest()} style={{ marginTop: 20, alignSelf: 'stretch' }} />
          <Button label="+30 s" variant="secondary" size="md" onPress={() => coach.current?.addRest(30)} style={{ marginTop: 10, alignSelf: 'stretch' }} />
        </View>
      )}

      {/* Paused, or asked to end */}
      {(paused || confirmEnd) && !done && (
        <View style={styles.overlay}>
          <Display size={48}>{confirmEnd ? 'End workout?' : 'Paused'}</Display>
          <Text style={styles.overlaySub}>{totalCount} {timed ? 'lifts' : 'reps'} saved so far · {mmss(elapsed)}</Text>
          <Button label={confirmEnd ? 'Keep going' : 'Resume'} icon="play" onPress={() => { setConfirmEnd(false); coach.current?.resume(); }} style={{ marginTop: 22, alignSelf: 'stretch' }} />
          <Button label="End workout" variant="secondary" size="md" onPress={() => { setConfirmEnd(false); coach.current?.end(); }} style={{ marginTop: 10, alignSelf: 'stretch' }} />
        </View>
      )}

      {/* Summary */}
      {done && (
        <View style={styles.overlay}>
          <Mascot pose="celebrate" size={130} animated />
          <Display size={40} style={{ marginTop: 6, textAlign: 'center' }}>Workout done</Display>
          <Text style={styles.overlaySub}>{ex.name} · {results.length} of {sets} sets</Text>
          <View style={[styles.stats, { marginTop: 18, alignSelf: 'stretch' }]}>
            <Stat value={String(totalCount)} label={timed ? 'Lifts' : 'Reps'} />
            <View style={styles.div} />
            <Stat value={mmss(elapsed)} label="Time" />
            <View style={styles.div} />
            <Stat value={avgScore == null ? '—' : String(avgScore)} label="Form" />
          </View>
          <Text style={[styles.overlaySub, { fontSize: 12, marginTop: 12 }]}>
            Scored by your coach and saved to your history.
            {xpGained != null ? ` +${xpGained} XP for the reps that counted.` : ''}
          </Text>
          {session ? (
            <Button label="View report" icon="arrow-right" onPress={() => router.replace({ pathname: '/exercise/session/[id]', params: { id: session.id } })} style={{ marginTop: 18, alignSelf: 'stretch' }} />
          ) : null}
          <Button label="Done" variant="secondary" size="md" onPress={() => (router.canGoBack() ? router.back() : router.replace('/exercise'))} style={{ marginTop: 10, alignSelf: 'stretch' }} />
        </View>
      )}
    </View>
  );
}

function Stat({ value, label, icon, iconColor }: { value: string; label: string; icon?: 'heart' | 'fire'; iconColor?: string }) {
  return (
    <View style={styles.stat}>
      {icon ? <Icon name={icon} size={18} color={iconColor} /> : null}
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function RoundBtn({ icon, label, onPress, size = 52, active }: { icon: React.ComponentProps<typeof Icon>['name']; label: string; onPress: () => void; size?: number; active?: boolean }) {
  return (
    <Pressable onPress={() => { tap(); onPress(); }} accessibilityLabel={label} style={[styles.round, { width: size, height: size, borderRadius: size / 2 }, active && { borderColor: colors.primary }]}>
      <Icon name={icon} size={size * 0.46} color={active ? colors.primary : colors.text} />
    </Pressable>
  );
}

const glass = 'rgba(17,17,19,0.78)';
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  stage: { position: 'absolute', left: 0, right: 0 },
  col: { flex: 1, paddingHorizontal: 16, width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center' },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  counter: { flexDirection: 'row', alignItems: 'center', backgroundColor: glass, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.line, paddingVertical: 12, paddingLeft: 12, paddingRight: 22, maxWidth: '72%' },
  exName: { color: colors.text, fontFamily: fonts.semibold, fontSize: 16 },
  count: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 30, lineHeight: 36 },
  setText: { color: colors.dim, fontFamily: fonts.mono, fontSize: 10, textTransform: 'uppercase' },
  round: { backgroundColor: glass, borderWidth: 1, borderColor: colors.lineHi, alignItems: 'center', justifyContent: 'center' },
  demoPill: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, marginTop: 10, backgroundColor: colors.imageChip, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 5 },
  demoDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.primary },
  demoText: { color: colors.onImageSub, fontFamily: fonts.mono, fontSize: 10, textTransform: 'uppercase' },
  rail: { alignItems: 'flex-end', gap: 12, marginBottom: 16 },
  kcalBig: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 26, lineHeight: 30 },
  kcalUnit: { color: colors.sub, fontFamily: fonts.medium, fontSize: 13, marginTop: -2 },
  cue: { backgroundColor: glass, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, paddingVertical: 10, paddingHorizontal: 16, maxWidth: 230 },
  cueTitle: { color: colors.primary, fontFamily: fonts.labelBold, fontSize: 20, textTransform: 'uppercase' },
  cueSub: { color: colors.sub, fontFamily: fonts.medium, fontSize: 14, marginTop: 1 },
  stats: { flexDirection: 'row', alignItems: 'center', backgroundColor: glass, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.line, paddingVertical: 14 },
  stat: { flex: 1, alignItems: 'center', minHeight: 58, justifyContent: 'flex-end' },
  statValue: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 26, lineHeight: 30 },
  statLabel: { color: colors.dim, fontFamily: fonts.medium, fontSize: 13 },
  div: { width: 1, alignSelf: 'stretch', backgroundColor: colors.line },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, marginTop: 18 },
  pauseRing: { width: 104, height: 104, borderRadius: 52, borderWidth: 4, borderColor: colors.secondary, alignItems: 'center', justifyContent: 'center', shadowColor: colors.secondary, shadowOpacity: 0.8, shadowRadius: 22, shadowOffset: { width: 0, height: 0 }, elevation: 12, backgroundColor: 'rgba(255,45,155,0.08)' },
  pauseInner: { width: 84, height: 84, borderRadius: 42, backgroundColor: '#0B0B0D', alignItems: 'center', justifyContent: 'center' },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(6,6,6,0.9)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 },
  kicker: { color: colors.primary, fontFamily: fonts.mono, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 },
  overlaySub: { color: colors.sub, fontFamily: fonts.medium, fontSize: 15, marginTop: 6, textAlign: 'center' },
  getReady: { position: 'absolute', left: 20, right: 20, alignItems: 'center', paddingVertical: 12, paddingHorizontal: 18, borderRadius: 20, backgroundColor: 'rgba(6,6,6,0.62)' },
  getReadySub: { color: colors.text, fontFamily: fonts.medium, fontSize: 13, marginTop: 2, textAlign: 'center' },
});
