/**
 * MOVEMENT ALARM — your alarms. Each one rings and only stops once you've moved (dance, squats,
 * jumps, shake). Alarms live on this device; AlarmService schedules them with the platform.
 */
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Mascot } from '@/art/Mascot';
import { AlarmCard, BigClock } from '@/components/alarm/AlarmParts';
import { Button, Card, Display, FadeIn, Header, Icon, Kicker, Screen, SectionHeader } from '@/components/ui';
import { AlarmService, streakOf, type Alarm } from '@/features/alarm/AlarmService';
import { nextFireAt, untilText } from '@/logic/alarmTime';
import { challengeSummary } from '@/logic/movementChallenges';
import { useApp } from '@/state/AppState';
import { alpha, colors, fonts, radius } from '@/theme';

export default function AlarmsScreen() {
  const { toast } = useApp();
  const [alarms, setAlarms] = useState<Alarm[] | null>(null);
  const [streak, setStreak] = useState(0);
  useEffect(() => AlarmService.subscribe(setAlarms), []);
  useEffect(() => {
    void AlarmService.history().then((h) => setStreak(streakOf(h)));
  }, [alarms]);

  const active = (alarms ?? []).filter((a) => a.enabled);
  const next = active.map((a) => ({ a, at: nextFireAt(a.time) })).sort((x, y) => x.at.getTime() - y.at.getTime())[0];

  const toggle = async (a: Alarm, on: boolean) => {
    const r = await AlarmService.setEnabled(a.id, on);
    if (r?.permission === 'denied') toast('Notifications are off — the alarm can’t ring. Turn them on in Settings.', 'bell-off-outline', colors.coral);
  };

  return (
    <Screen tabBar={false}>
      <Header back title="" />
      <Kicker color={colors.secondary}>No snoozing</Kicker>
      <Display size={46} style={{ marginTop: 4 }}>
        Movement{'\n'}
        <Text style={{ color: colors.primary }}>alarm</Text>
      </Display>
      <Text style={styles.lead}>Your alarm only stops once you move. Dance it off, squat it off, jump it off.</Text>

      <FadeIn>
        <Card style={styles.hero}>
          <View style={{ flex: 1 }}>
            {next ? (
              <>
                <Text style={styles.heroKicker}>Next wake-up</Text>
                <BigClock time={next.a.time} size={54} />
                <Text style={styles.heroSub}>{challengeSummary(next.a.challenge, next.a.amount)} · {untilText(next.at)}</Text>
              </>
            ) : (
              <>
                <Text style={styles.heroKicker}>Nothing set</Text>
                <Text style={styles.heroEmpty}>Set an alarm and make tomorrow-you move.</Text>
              </>
            )}
            {streak > 0 && (
              <View style={styles.streak}>
                <Icon name="fire" size={14} color={colors.orange} />
                <Text style={styles.streakText}>{streak}-day wake-up streak</Text>
              </View>
            )}
          </View>
          <Mascot pose="sleep" accessory="headphones" size={104} animated />
        </Card>
      </FadeIn>

      <Button label="Set an alarm" iconLeft="alarm-plus" onPress={() => router.push('/alarm/edit')} style={{ marginTop: 14 }} />

      <SectionHeader title="Your alarms" />
      {alarms === null ? null : alarms.length ? (
        <View style={{ gap: 10 }}>
          {alarms.map((a, i) => (
            <FadeIn key={a.id} index={i}>
              <AlarmCard alarm={a} onPress={() => router.push({ pathname: '/alarm/edit', params: { id: a.id } })} onToggle={(on) => void toggle(a, on)} />
            </FadeIn>
          ))}
        </View>
      ) : (
        <Text style={styles.empty}>No alarms yet.</Text>
      )}

      <SectionHeader title="Try it" />
      <Button
        label="Practice a challenge"
        variant="secondary"
        size="md"
        iconLeft="play-circle-outline"
        onPress={() => router.push({ pathname: '/alarm/ring/[id]', params: { id: 'practice', challenge: 'dance', amount: '10' } })}
      />
      <View style={styles.note}>
        <Icon name="information-outline" size={16} color={colors.dim} />
        <Text style={styles.noteText}>{AlarmService.scheduler.note}</Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  lead: { color: colors.dim, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, marginTop: 8 },
  hero: { flexDirection: 'row', alignItems: 'center', marginTop: 16, gap: 8, borderColor: alpha(colors.primary, 0.35) },
  heroKicker: { color: colors.secondary, fontFamily: fonts.label, fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase' },
  heroSub: { color: colors.sub, fontFamily: fonts.medium, fontSize: 13 },
  heroEmpty: { color: colors.text, fontFamily: fonts.semibold, fontSize: 16, marginTop: 6, lineHeight: 22 },
  streak: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 10, alignSelf: 'flex-start', backgroundColor: alpha(colors.orange, 0.12), borderRadius: radius.pill, paddingHorizontal: 9, paddingVertical: 4 },
  streakText: { color: colors.orange, fontFamily: fonts.semibold, fontSize: 12 },
  empty: { color: colors.dim, fontFamily: fonts.regular, fontSize: 13 },
  note: { flexDirection: 'row', gap: 8, marginTop: 14, alignItems: 'flex-start' },
  noteText: { flex: 1, color: colors.dim, fontFamily: fonts.regular, fontSize: 12, lineHeight: 17 },
});
