/**
 * ALARM RINGING — full screen, no dismiss and no snooze. The only ways out:
 *   beat the movement challenge (real motion detection), or — only if this device can't detect
 *   movement / access was refused / detection failed — beat the backup challenge (catch the
 *   squirrel). A practice round (`id = practice`) can be left at any time and isn't recorded.
 *
 * Flow: wake → (permission) → moving → defeated. Device access goes through
 * MovementDetectionService; alarm bookkeeping through AlarmService.
 */
import { useEffect, useRef, useState } from 'react';
import { BackHandler, Linking, Platform, ScrollView, StyleSheet, Text, Vibration, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { CatchSquirrel, DefeatedView, MovingView, PermissionView, permissionModeOf, WakeIntro, type PermissionMode } from '@/components/alarm/ChallengeViews';
import { IconButton } from '@/components/ui';
import { AlarmService, type Alarm } from '@/features/alarm/AlarmService';
import { isNoMotionData, MovementDetectionService, setSimulatedMoving, SIMULATOR_ALLOWED, type MovementDetector } from '@/features/alarm/MovementDetectionService';
import { useMovementChallenge } from '@/features/alarm/useMovementChallenge';
import { challengeById } from '@/logic/movementChallenges';
import { colors, fonts, MAX_WIDTH } from '@/theme';

type Phase = 'loading' | 'missing' | 'wake' | 'checking' | 'permission' | 'moving' | 'backup' | 'done';
type Setup = { challenge: string; amount: number; label: string | null };

export default function AlarmRingRoute() {
  const params = useLocalSearchParams<{ id: string; challenge?: string; amount?: string }>();
  const practice = params.id === 'practice';
  const [setup, setSetup] = useState<Setup | null>(() => (practice ? { challenge: challengeById(params.challenge ?? 'dance').id, amount: Number(params.amount) || challengeById(params.challenge ?? 'dance').defaultAmount, label: null } : null));
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (practice) return;
    void AlarmService.get(params.id).then((a: Alarm | null) => (a ? setSetup({ challenge: a.challenge, amount: a.amount, label: a.label }) : setMissing(true)));
  }, [params.id, practice]);

  if (missing) return <RingShell><Missing /></RingShell>;
  if (!setup) return <RingShell>{null}</RingShell>;
  return <Ring alarmId={params.id} setup={setup} practice={practice} />;
}

function Ring({ alarmId, setup, practice }: { alarmId: string; setup: Setup; practice: boolean }) {
  const [phase, setPhase] = useState<Phase>('wake');
  const [detector, setDetector] = useState<MovementDetector | null>(null);
  const [perm, setPerm] = useState<{ mode: PermissionMode; reason: string | null }>({ mode: 'ask', reason: null });
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<{ seconds: number; streak: number | null } | null>(null);
  // A ref for the completion callback, state for rendering.
  const usedBackup = useRef(false);
  const [backupUsed, setBackupUsed] = useState(false);

  const ch = useMovementChallenge(setup.challenge, setup.amount, {
    // A sensor that dies mid-challenge → the failure screen (progress is kept for the retry).
    onFail: (error) => {
      // No readings at all → this device can't sense movement; readings that stop → lost signal.
      if (isNoMotionData(error)) setPerm({ mode: 'unsupported', reason: 'No motion readings came from this device.' });
      else setPerm({ mode: 'failed', reason: 'Your phone stopped sending movement data.' });
      setPhase('permission');
    },
    // Beaten → record it (real alarms only) → defeated screen.
    onDone: (startedAt, doneAt) => {
      setSimulatedMoving(false);
      const seconds = Math.max(1, Math.round((doneAt - startedAt) / 1000));
      setPhase('done');
      if (practice) return setResult({ seconds, streak: null });
      void AlarmService.defeated({ alarmId, challenge: ch.def.id, amount: setup.amount, defeatedAt: new Date(doneAt).toISOString(), secondsToDefeat: seconds, usedBackup: usedBackup.current }).then((r) =>
        setResult({ seconds, streak: r.streak }),
      );
    },
  });
  const def = ch.def;

  // Ringing: mark it (a second trigger won't stack another challenge) and buzz until you start.
  useEffect(() => {
    if (practice) return;
    AlarmService.markRinging(alarmId, true);
    return () => AlarmService.markRinging(alarmId, false);
  }, [alarmId, practice]);
  useEffect(() => {
    if (practice || phase !== 'wake' || Platform.OS === 'web') return;
    Vibration.vibrate([0, 700, 500], true);
    return () => Vibration.cancel();
  }, [phase, practice]);

  // No hardware-back escape from a real alarm before it's beaten.
  useEffect(() => {
    if (practice || phase === 'done') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, [phase, practice]);

  const go = (d: MovementDetector) => {
    setPhase('moving');
    ch.start(d);
  };

  /** Pick a detector; start straight away if it's ready, otherwise show what's needed. */
  const begin = async (opts: { simulate?: boolean } = {}) => {
    setPhase('checking');
    const { detector: d, status } = await MovementDetectionService.pick(opts);
    setDetector(d);
    const mode = permissionModeOf(status);
    if (!mode) return go(d);
    setPerm({ mode, reason: status.state === 'unsupported' ? status.reason : null });
    setPhase('permission');
  };

  const allow = async () => {
    if (!detector) return;
    setAsking(true);
    const s = await detector.requestPermission();
    setAsking(false);
    const mode = permissionModeOf(s);
    if (!mode) return go(detector);
    setPerm({ mode, reason: s.state === 'unsupported' ? s.reason : null });
  };

  const leave = () => {
    ch.stop();
    if (router.canGoBack()) router.back();
    else router.replace('/home');
  };

  return (
    <RingShell onQuit={practice && phase !== 'done' ? leave : undefined} practice={practice}>
      {phase === 'wake' && <WakeIntro def={def} amount={setup.amount} label={setup.label} practice={practice} onStart={() => void begin()} />}
      {phase === 'checking' && <Text style={styles.checking}>Waking up the sensors…</Text>}
      {phase === 'permission' && detector && (
        <PermissionView
          mode={perm.mode}
          why={detector.why}
          reason={perm.reason}
          busy={asking}
          onAllow={() => void allow()}
          onOpenSettings={() => void Linking.openSettings().catch(() => {})}
          onRetry={() => void begin()}
          onBackup={() => {
            usedBackup.current = true;
            setBackupUsed(true);
            setPhase('backup');
          }}
          onSimulate={SIMULATOR_ALLOWED ? () => void begin({ simulate: true }) : undefined}
        />
      )}
      {phase === 'moving' && <MovingView def={def} state={ch.state} simulated={detector?.id === 'simulated'} onSimulate={setSimulatedMoving} />}
      {phase === 'backup' && <CatchSquirrel caught={ch.state.progress} target={ch.state.target} onCatch={ch.credit} />}
      {phase === 'done' && <DefeatedView seconds={result?.seconds ?? 0} streak={result?.streak ?? null} practice={practice} usedBackup={backupUsed} onContinue={() => router.replace(practice ? '/alarm' : '/home')} />}
    </RingShell>
  );
}

function Missing() {
  return (
    <View style={{ alignItems: 'center', gap: 14 }}>
      <Text style={styles.checking}>This alarm was deleted, so there’s nothing to beat.</Text>
      <Text style={styles.link} onPress={() => router.replace('/home')} accessibilityRole="button">Go home</Text>
    </View>
  );
}

function RingShell({ children, onQuit, practice }: { children: React.ReactNode; onQuit?: () => void; practice?: boolean }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24 }]} bounces={false}>
        <View style={{ flexGrow: 1, width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center' }}>
          <View style={styles.top}>
            <Text style={styles.brand}>{practice ? 'Practice round' : 'Squirrel Social · Alarm'}</Text>
            {onQuit ? <IconButton icon="close" label="Quit practice" onPress={onQuit} /> : <View style={{ height: 40 }} />}
          </View>
          <View style={{ flexGrow: 1, justifyContent: 'center' }}>{children}</View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { flexGrow: 1, paddingHorizontal: 20 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  brand: { color: colors.dim, fontFamily: fonts.label, fontSize: 12, letterSpacing: 1.4, textTransform: 'uppercase' },
  checking: { color: colors.sub, fontFamily: fonts.medium, fontSize: 15, textAlign: 'center' },
  link: { color: colors.primary, fontFamily: fonts.semibold, fontSize: 15 },
});
