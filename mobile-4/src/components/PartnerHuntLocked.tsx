import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Mascot } from '@/art/Mascot';
import { SceneImage } from '@/components/cards';
import { SoonPill } from '@/components/Locked';
import { Button, Display, FadeIn, Header, Icon, Kicker, Screen, Tagline } from '@/components/ui';
import { MATCH_FACTORS, PARTNER_HUNT_FLOW } from '@/data/partnerHunt';
import { useConfig } from '@/hooks/useCampus';
import { alpha, colors, fonts, radius } from '@/theme';

/**
 * Partner Hunt while it's locked: what it is, how it'll work and what you'll match on.
 * No buddies and no matching, just a preview of the flow.
 */
export function PartnerHuntLocked() {
  const campus = useConfig().data?.campus.name ?? 'your campus';
  const back = () => (router.canGoBack() ? router.back() : router.replace('/social'));

  return (
    <Screen tabBar={false}>
      <Header back title="" right={<SoonPill />} />

      <FadeIn>
        <SceneImage kind="crew" seed={33} height={210} scrim="strong">
          <View style={styles.lockBadge}>
            <Icon name="lock" size={18} color={colors.onPrimary} />
          </View>
          <Mascot pose="wave" size={120} animated style={styles.mascot} />
          <View style={{ position: 'absolute', left: 16, bottom: 16, right: 110 }}>
            <Kicker color={colors.primary}>Coming soon</Kicker>
            <Display size={40} color={colors.onImage} style={{ marginTop: 4 }}>Partner Hunt</Display>
            <Tagline size={18} color={colors.onImage} rotate={-3} style={{ marginTop: 2 }}>Find your workout buddy.</Tagline>
          </View>
        </SceneImage>
      </FadeIn>

      <Text style={styles.lead}>
        Match with people on <Text style={{ color: colors.text, fontFamily: fonts.semibold }}>{campus}</Text> who train like you do, then hit the next session together. We&apos;re putting the finishing touches on it.
      </Text>

      {/* How it'll work */}
      <Text style={styles.section}>How it’ll work</Text>
      <View style={styles.flow}>
        {PARTNER_HUNT_FLOW.map((s, i) => (
          <FadeIn key={s.id} index={i}>
            <View style={styles.step}>
              <View style={styles.stepRail}>
                <View style={styles.stepDot}>
                  <Icon name={s.icon} size={18} color={colors.primary} />
                </View>
                {i < PARTNER_HUNT_FLOW.length - 1 && <View style={styles.stepLine} />}
              </View>
              <View style={{ flex: 1, paddingBottom: i < PARTNER_HUNT_FLOW.length - 1 ? 16 : 0 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={styles.stepNo}>{String(i + 1).padStart(2, '0')}</Text>
                  <Text style={styles.stepTitle}>{s.title}</Text>
                </View>
                <Text style={styles.stepBody}>{s.body}</Text>
              </View>
              <Icon name="lock-outline" size={16} color={colors.mute} style={{ marginTop: 8 }} />
            </View>
          </FadeIn>
        ))}
      </View>

      {/* What you'll match on */}
      <Text style={styles.section}>You’ll match on</Text>
      <View style={styles.factors}>
        {MATCH_FACTORS.map((f) => (
          <View key={f.id} style={styles.factor}>
            <Icon name={f.icon} size={15} color={colors.primary} />
            <Text style={styles.factorText}>{f.id === 'campus' ? campus : f.label}</Text>
          </View>
        ))}
      </View>

      <View style={styles.notice}>
        <Icon name="timer-sand" size={18} color={colors.dim} />
        <Text style={[styles.stepBody, { flex: 1, marginTop: 0 }]}>Partner Hunt isn&apos;t open yet. Nothing to set up now; it&apos;ll show up right here when it launches.</Text>
      </View>

      <Button label="Find your crew meanwhile" icon="arrow-right" size="md" onPress={() => router.push('/crews')} style={{ marginTop: 18 }} />
      <Button label="Go back" variant="secondary" size="md" onPress={back} style={{ marginTop: 10 }} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  lockBadge: { position: 'absolute', top: 12, left: 12, width: 34, height: 34, borderRadius: 17, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  mascot: { position: 'absolute', right: 0, bottom: -6 },
  lead: { color: colors.sub, fontFamily: fonts.regular, fontSize: 14, lineHeight: 21, marginTop: 14 },
  section: { color: colors.dim, fontFamily: fonts.label, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase', marginTop: 24, marginBottom: 10 },
  flow: { backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 14 },
  step: { flexDirection: 'row', gap: 12 },
  stepRail: { alignItems: 'center', width: 36 },
  stepDot: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: alpha(colors.primary, 0.1), borderWidth: 1, borderColor: alpha(colors.primary, 0.35) },
  stepLine: { flex: 1, width: 2, backgroundColor: colors.line, marginTop: 4, borderRadius: 1 },
  stepNo: { color: colors.primary, fontFamily: fonts.labelBold, fontSize: 13 },
  stepTitle: { color: colors.text, fontFamily: fonts.label, fontSize: 16, letterSpacing: 0.8, textTransform: 'uppercase' },
  stepBody: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, marginTop: 2 },
  factors: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  factor: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.card, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 12, paddingVertical: 7 },
  factorText: { color: colors.sub, fontFamily: fonts.label, fontSize: 13, letterSpacing: 0.6, textTransform: 'uppercase' },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.lineHi, borderStyle: 'dashed', padding: 12 },
});
