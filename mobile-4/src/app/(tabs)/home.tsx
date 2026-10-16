import { EXERCISE_LIBRARY } from '@/data/exercises';
import { useExerciseCatalog } from '@/hooks/useExercise';
import { useLocks } from '@/components/Locked';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { CampusScene } from '@/art/CampusScene';
import { GoalCard, SceneImage } from '@/components/cards';
import { CAMPUS_SOURCE } from '@/api/campus';
import { CampusToday, WaitlistCard } from '@/components/campus/CampusToday';
import { ActiveNowStrip, CampusNotLive, CampusTerritoryCard, HomeEvents, HomeLeaderboard, SocialShortcuts } from '@/components/campus/HomeSections';
import { ErrorState, LoadingRows, NotConnected } from '@/components/campus/States';
import { TopBar } from '@/components/TopBar';
import { Card, Display, FadeIn, Icon, OverlayKicker, OverlaySub, PressScale, Ring, RowSub, RowTitle, Screen, SectionHeader, Tagline } from '@/components/ui';
import { Tape } from '@/components/Brand';
import { useConfig, useMe } from '@/hooks/useCampus';
import { useDailyProgress } from '@/hooks/useDailyProgress';
import { goalTargets } from '@/logic/progressStats';
import { useApp } from '@/state/AppState';
import { alpha, colors, fonts, radius } from '@/theme';

/**
 * HOME. Every number here comes from a backend: today's active minutes / calories /
 * streak and goals from the progress-service, territory / people / leaderboard from the campus
 * API, XP from the progress-service or the Run Module. Without a backend a section says so
 * ("Not connected" / "Not live yet"); there is no sample content.
 */
const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

export default function Home() {
  const { me, exerciseToday } = useApp();
  const profile = useMe();
  const config = useConfig();
  const campus = config.data?.campus.name ?? null;
  const daily = useDailyProgress();
  const locks = useLocks();
  const eventsLocked = locks.locked('events');
  const d = daily.data;
  const goals = d?.goals ?? [];
  const targets = goalTargets(goals);
  const goalsDone = goals.filter((g) => g.completed || g.current >= g.target).length;

  // Your profile name when a profile backend answers; the sign-in handle otherwise.
  const firstName = (profile.data?.display_name && profile.data.display_name !== 'New Squirrel' ? profile.data.display_name.split(' ')[0] : null) ?? me.name;

  return (
    <Screen>
      <TopBar />

      {/* Greeting */}
      <FadeIn style={{ marginTop: 18 }}>
        <Text style={styles.hello}>{greeting()}{firstName ? `, ${firstName}` : ''} 👋</Text>
        <Display size={44} style={{ marginTop: 2 }}>Ready to <Text style={{ color: colors.primary }}>move?</Text></Display>
      </FadeIn>

      {/* Today's progress (progress-service) */}
      <FadeIn index={1}>
        <Card style={{ marginTop: 14, paddingVertical: 16 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Text style={styles.cardTitle}>Today’s progress</Text>
            <Pressable onPress={() => router.push('/progress')} hitSlop={8} style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={styles.link}>Stats</Text>
              <Icon name="chevron-right" size={16} color={colors.primary} />
            </Pressable>
          </View>
          {daily.state !== 'ready' ? (
            <Text style={styles.note}>{daily.state === 'signed_out' ? 'Sign in to see your active minutes, calories and streak.' : 'Active minutes, calories and streak come from the Run Module, which isn’t connected to this build yet.'}</Text>
          ) : daily.error && !d ? (
            <ErrorState cause={daily.cause} onRetry={daily.reload} compact title="Couldn’t load today" />
          ) : !d ? (
            <LoadingRows rows={1} height={92} />
          ) : (
            <View style={styles.rings}>
              <RingStat progress={targets.active ? d.activeMinutes / targets.active : 0} color={colors.secondary} color2={colors.blue} icon="timer-outline" value={`${Math.round(d.activeMinutes)}m`} label="Active" />
              <RingStat progress={0} color={colors.orange} color2={colors.gold} icon="fire" value={String(Math.round(d.calories))} label="kcal" />
              <RingStat progress={Math.min(1, d.streak.current / 14)} color={colors.violet} color2={colors.primary} icon="lightning-bolt" value={`${d.streak.current}d`} label="Streak" />
            </View>
          )}
          {exerciseToday.sessions > 0 && daily.state !== 'ready' && (
            <Text style={[styles.note, { marginTop: 8 }]}>On this phone today: {exerciseToday.sessions} workout{exerciseToday.sessions > 1 ? 's' : ''} · {exerciseToday.minutes} min</Text>
          )}
          <StartExercise />
        </Card>
      </FadeIn>

      {/* Start run CTA */}
      <FadeIn index={2}>
        <PressScale onPress={() => router.push('/run')} style={{ marginTop: 14 }} scaleTo={0.98}>
          <SceneImage kind="run" seed={4} height={132} scrim="strong">
            <View style={styles.runCta}>
              <View style={{ flex: 1 }}>
                <OverlayKicker>Run or walk</OverlayKicker>
                <Display size={30} color={colors.onImage}>Start a run</Display>
                <OverlaySub>Your route unlocks zones to claim</OverlaySub>
              </View>
              <View style={styles.playBtn}>
                <Icon name="play" size={30} color={colors.onPrimary} />
              </View>
            </View>
          </SceneImage>
        </PressScale>
      </FadeIn>

      {/* Campus today — daily activity across campus (Social service) */}
      <CampusToday />

      {/* Today's goals (progress-service) */}
      <SectionHeader kicker="01 — Today" title="Today's Goals" action={d ? `${goalsDone}/${goals.length} done` : 'Open'} onAction={() => router.push('/missions')} />
      {daily.state !== 'ready' ? (
        <NotConnected compact name="Today’s goals" reason={daily.state} body={daily.state === 'signed_out' ? 'Your daily goals come from your account.' : 'Daily goals come from the progress service, which isn’t connected to this build yet.'} />
      ) : !d ? (
        daily.error ? null : <LoadingRows rows={2} height={72} />
      ) : goals.length === 0 ? (
        <Card>
          <Text style={styles.note}>No goals set for today.</Text>
        </Card>
      ) : (
        <View style={{ gap: 10 }}>
          {goals.slice(0, 3).map((g, i) => (
            <FadeIn key={g.id} index={i}>
              <GoalCard goal={g} />
            </FadeIn>
          ))}
        </View>
      )}

      <Tape items={['Touch grass (literally)', 'Every run leaves a mark', 'Claim your block', 'No pressure, all vibes']} color={colors.secondary} rotate={2} style={{ marginTop: 26, marginBottom: -6 }} />

      {/* Territory — the campus map's zones (backend truth) */}
      <SectionHeader kicker="02 — Territory" title="Own your campus" action="Map" onAction={() => router.push('/explore')} />
      {CAMPUS_SOURCE === 'off' ? <CampusNotLive /> : <CampusTerritoryCard />}
      {CAMPUS_SOURCE !== 'off' && <ActiveNowStrip />}
      {CAMPUS_SOURCE !== 'off' && <SocialShortcuts />}

      {/* Challenges */}
      <PressScale onPress={() => router.push('/challenges')} scaleTo={0.98} style={{ marginTop: 12 }}>
        <View style={styles.battle}>
          <Icon name="sword-cross" size={26} color={colors.secondary} />
          <View style={{ flex: 1 }}>
            <RowTitle>Choose your battle</RowTitle>
            <Text style={styles.zoneInfo}>Daily, head-to-head, group & special challenges</Text>
          </View>
          <Icon name="chevron-right" size={24} color={colors.secondary} />
        </View>
      </PressScale>

      {/* Waitlist & invites (Social service) */}
      <WaitlistCard />

      {/* A window onto the campus that opens the Map (artwork, no data) */}
      <FadeIn>
        <PressScale onPress={() => router.push('/explore')} style={styles.world} scaleTo={0.985} accessibilityRole="button" accessibilityLabel={`${campus ?? 'Your campus'}. Open the map`}>
          <CampusScene frame="horizon" style={StyleSheet.absoluteFill} />
          <LinearGradient colors={['rgba(5,5,7,0)', 'rgba(5,5,7,0.88)']} style={styles.worldScrim} pointerEvents="none" />
          <View style={{ position: 'absolute', left: 16, bottom: 16, right: 16 }}>
            <OverlayKicker>{campus ?? 'Your campus'} · your world</OverlayKicker>
            <Tagline size={24} color={colors.onImage} style={{ marginTop: 6 }}>The campus is awake.</Tagline>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 20 }}>
              <Text style={styles.worldCta}>Open the map</Text>
              <Icon name="arrow-right" size={16} color={colors.primary} />
            </View>
          </View>
        </PressScale>
      </FadeIn>

      {/* Leaderboard — top squirrels today, from the campus backend */}
      {CAMPUS_SOURCE !== 'off' && <HomeLeaderboard campusName={campus ?? 'your campus'} />}

      {/* Events — campus events (RSVP state lives on the server) */}
      {CAMPUS_SOURCE !== 'off' && !eventsLocked && <HomeEvents />}
    </Screen>
  );
}

/** Start Exercise: the footer of Today's progress. Opens the exercise picker (backend catalog). */
function StartExercise() {
  const { activeExercise, exerciseToday } = useApp();
  const catalog = useExerciseCatalog();
  const ready = catalog.data?.filter((e) => e.status === 'enabled').length;
  const activeName = activeExercise ? EXERCISE_LIBRARY.find((e) => e.key === activeExercise.key)?.name ?? 'Exercise' : null;
  const sub = activeName
    ? `${activeName} in progress · tap to resume`
    : exerciseToday.sessions
      ? `${exerciseToday.sessions} done today · ${exerciseToday.minutes} min · keep it going`
      : ready
        ? `${ready} exercises ready · form-coached reps`
        : 'Form-coached reps and timed sets';
  const open = () =>
    activeExercise
      ? router.push({ pathname: '/exercise/train/[key]', params: { key: activeExercise.key, session: activeExercise.sessionId ?? '' } })
      : router.push('/exercise/select');
  return (
    <PressScale onPress={open} scaleTo={0.985} style={styles.exRow} accessibilityLabel={activeName ? `Resume ${activeName}` : 'Start Exercise'}>
      <View style={styles.exIcon}>
        <Icon name={activeName ? 'play-circle' : 'arm-flex'} size={22} color={colors.onPrimary} />
      </View>
      <View style={{ flex: 1, marginLeft: 12 }}>
        <RowTitle>{activeName ? 'Resume exercise' : 'Start Exercise'}</RowTitle>
        <RowSub>{sub}</RowSub>
      </View>
      <View style={styles.exGo}>
        <Text style={styles.exGoText}>{activeName ? 'Resume' : 'Start'}</Text>
        <Icon name="arrow-right" size={16} color={colors.onPrimary} />
      </View>
    </PressScale>
  );
}

function RingStat({ progress, color, color2, icon, value, label }: { progress: number; color: string; color2: string; icon: React.ComponentProps<typeof Icon>['name']; value: string; label: string }) {
  return (
    <View style={{ alignItems: 'center', flex: 1 }}>
      <Ring progress={progress} size={62} stroke={6} color={color} color2={color2}>
        <Icon name={icon} size={20} color={color} />
      </Ring>
      <Text style={styles.ringValue}>{value}</Text>
      <Text style={styles.ringLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  world: { height: 176, marginTop: 22, borderRadius: radius.xl, overflow: 'hidden', borderWidth: 1, borderColor: colors.line, backgroundColor: '#07060C' },
  worldScrim: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 130 },
  worldCta: { color: colors.primary, fontFamily: fonts.labelBold, fontSize: 14, letterSpacing: 1.2, textTransform: 'uppercase' },
  exRow: { flexDirection: 'row', alignItems: 'center', marginTop: 16, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.line },
  exIcon: { width: 42, height: 42, borderRadius: 13, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  exGo: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.primary, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 8, marginLeft: 8 },
  exGoText: { color: colors.onPrimary, fontFamily: fonts.labelBold, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' },
  zone: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 2, borderColor: colors.primary, padding: 14, transform: [{ rotate: '-0.6deg' }], shadowColor: colors.primary, shadowOpacity: 0.25, shadowRadius: 14, shadowOffset: { width: 0, height: 0 } },
  zoneKicker: { color: colors.primary, fontFamily: fonts.monoBold, fontSize: 10, letterSpacing: 1.4 },
  zonePct: { color: colors.primary, fontFamily: fonts.labelBold, fontSize: 18 },
  zoneInfo: { color: colors.dim, fontFamily: fonts.mono, fontSize: 10, marginTop: 6 },
  battle: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: alpha(colors.text, 0.5), padding: 14 },
  hello: { color: colors.sub, fontFamily: fonts.semibold, fontSize: 15, flexShrink: 1 },
  cardTitle: { color: colors.text, fontFamily: fonts.bold, fontSize: 15 },
  link: { color: colors.primary, fontFamily: fonts.semibold, fontSize: 13 },
  rings: { flexDirection: 'row', justifyContent: 'space-between' },
  ringValue: { color: colors.text, fontFamily: fonts.display, fontSize: 18, marginTop: 6, letterSpacing: 0.3 },
  ringLabel: { color: colors.dim, fontFamily: fonts.medium, fontSize: 11 },
  runCta: { position: 'absolute', left: 16, right: 16, bottom: 14, flexDirection: 'row', alignItems: 'flex-end' },
  playBtn: { width: 58, height: 58, borderRadius: 29, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', shadowColor: colors.primary, shadowOpacity: 0.8, shadowRadius: 14, shadowOffset: { width: 0, height: 0 } },
  hint: { color: colors.mute, fontSize: 12, textAlign: 'center', marginTop: 8, fontFamily: fonts.regular },
  note: { color: colors.dim, fontFamily: fonts.regular, fontSize: 13, lineHeight: 19 },
  leader: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 4 },
  leaderMe: { backgroundColor: alpha(colors.primary, 0.08), borderRadius: radius.md, marginHorizontal: -6, paddingHorizontal: 10 },
  rank: { color: colors.dim, fontFamily: fonts.display, fontSize: 18, width: 34 },
  leaderName: { color: colors.text, fontFamily: fonts.bold, fontSize: 14 },
  leaderSub: { color: colors.dim, fontFamily: fonts.regular, fontSize: 11 },
  leaderXp: { color: colors.gold, fontFamily: fonts.bold, fontSize: 13 },
  activity: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 10 },
  activityText: { flex: 1, color: colors.sub, fontFamily: fonts.regular, fontSize: 13, lineHeight: 18 },
});
