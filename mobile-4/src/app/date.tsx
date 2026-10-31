/**
 * DATE MODE — behind a safety gate. It unlocks only when the backend's config reports the
 * safety stack live (`features.date_mode.available`) — the screen existing is not enough.
 * When open: a Date Mode toggle, then activity-first profiles with shared context, suggested
 * activities and icebreakers. No photo-first swiping.
 */
import { useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Mascot } from '@/art/Mascot';
import { campusApi, errorText, type PersonCard } from '@/api/campus';
import { PersonCardView } from '@/components/campus/Social';
import { EmptyNote, ErrorState, LoadingRows, SignedOutState, SourceBadge } from '@/components/campus/States';
import { Card, Display, Header, Icon, Kicker, Screen, SectionHeader, tap } from '@/components/ui';
import { invalidateCampus, useAction, useCampus, useConfig, useMe } from '@/hooks/useCampus';
import { alpha, colors, fonts, radius } from '@/theme';

export default function DateMode() {
  const config = useConfig();
  const me = useMe();
  const gate = config.data?.features.date_mode;
  const [enabledLocal, setEnabledLocal] = useState<boolean | null>(null);
  const enabled = enabledLocal ?? me.data?.date_mode_enabled ?? false;
  const toggle = useAction((on: boolean) => campusApi.updateMe({ date_mode_enabled: on }));
  const people = useCampus<PersonCard[]>('people:date', () => campusApi.suggestedPeople('date'), { enabled: !!gate?.available && enabled });

  const header = <Header back title="" right={<SourceBadge />} />;
  if (!config.data) {
    return (
      <Screen tabBar={false}>
        {header}
        {config.error ? <ErrorState cause={config.cause} onRetry={config.reload} /> : <LoadingRows rows={3} />}
      </Screen>
    );
  }

  if (!gate?.available) {
    return (
      <Screen tabBar={false}>
        {header}
        <View style={{ alignItems: 'center' }}>
          <Mascot pose="sit" size={130} />
        </View>
        <Kicker color={colors.secondary} style={{ alignSelf: 'center' }}>Date Mode · locked</Kicker>
        <Display size={36} style={{ textAlign: 'center', marginTop: 4 }}>Safety first.{'\n'}<Text style={{ color: colors.secondary }}>Then dates.</Text></Display>
        <Text style={styles.lead}>{gate?.reason ?? 'Date Mode opens once campus safety features are live.'}</Text>
        <Card style={{ marginTop: 16, gap: 12 }}>
          {(gate?.requirements ?? []).map((r) => (
            <View key={r.id} style={{ flexDirection: 'row', gap: 10 }}>
              <Icon name="shield-lock-outline" size={20} color={colors.secondary} />
              <View style={{ flex: 1 }}>
                <Text style={styles.reqTitle}>{r.label}</Text>
                {!!r.description && <Text style={styles.reqBody}>{r.description}</Text>}
              </View>
            </View>
          ))}
          {!gate?.requirements.length && <Text style={styles.reqBody}>The requirements will be listed here.</Text>}
        </Card>
        <Text style={styles.fine}>Until then, Friend Mode and crews are the best way to meet people.</Text>
        <EmptyNote icon="account-heart-outline" title="Try Friend Mode" action="Open Friend Mode" onAction={() => router.replace('/friends')} />
      </Screen>
    );
  }

  if (me.signedOut) {
    return (
      <Screen tabBar={false}>
        {header}
        <SignedOutState what="Date Mode" />
      </Screen>
    );
  }

  const flip = async (on: boolean) => {
    tap();
    const r = await toggle.run(on);
    if (r) {
      setEnabledLocal(r.date_mode_enabled);
      invalidateCampus('me');
      invalidateCampus('people:date');
    }
  };

  return (
    <Screen tabBar={false}>
      {header}
      <Kicker color={colors.secondary}>Date Mode</Kicker>
      <Display size={38} style={{ marginTop: 4 }}>Move first,{'\n'}<Text style={{ color: colors.secondary }}>then meet.</Text></Display>
      <Card style={[styles.toggle, enabled && { borderColor: colors.secondary }]}>
        <Icon name="heart-multiple" size={22} color={enabled ? colors.secondary : colors.dim} />
        <View style={{ flex: 1 }}>
          <Text style={styles.reqTitle}>Date Mode · {toggle.status === 'loading' ? 'saving…' : enabled ? 'ON' : 'OFF'}</Text>
          <Text style={styles.reqBody}>Only other verified students in Date Mode can see you here. First meetups are suggested in busy campus zones.</Text>
        </View>
        <Switch value={enabled} onValueChange={flip} disabled={toggle.status === 'loading'} trackColor={{ false: colors.lineHi, true: alpha(colors.secondary, 0.45) }} thumbColor={enabled ? colors.secondary : colors.dim} accessibilityLabel="Date Mode" />
      </Card>
      {toggle.status === 'error' && <Text style={styles.err}>{errorText(toggle.error)}</Text>}

      {enabled && (
        <>
          <SectionHeader title="People you move near" />
          {people.error ? (
            <ErrorState cause={people.cause} onRetry={people.reload} />
          ) : !people.data ? (
            <LoadingRows rows={2} height={200} />
          ) : people.data.length === 0 ? (
            <EmptyNote title="No one yet" body="As more people turn on Date Mode, activity-based matches show up here." />
          ) : (
            <View style={{ gap: 12 }}>
              {people.data.map((p) => (
                <View key={p.user_id} style={{ gap: 8 }}>
                  <PersonCardView p={p} />
                  {!!p.suggested_activities?.length && (
                    <View style={styles.suggest}>
                      <Text style={styles.suggestTitle}>Low-key first plans</Text>
                      {p.suggested_activities.map((a) => (
                        <Text key={a} style={styles.suggestItem}>• {a}</Text>
                      ))}
                    </View>
                  )}
                </View>
              ))}
            </View>
          )}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  lead: { color: colors.dim, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 10 },
  reqTitle: { color: colors.text, fontFamily: fonts.label, fontSize: 15, letterSpacing: 0.8, textTransform: 'uppercase' },
  reqBody: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, marginTop: 2 },
  fine: { color: colors.mute, fontFamily: fonts.mono, fontSize: 11, textAlign: 'center', marginTop: 16 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 14 },
  err: { color: colors.coral, fontFamily: fonts.medium, fontSize: 13, marginTop: 8 },
  suggest: { backgroundColor: colors.cardHi, borderRadius: radius.md, padding: 12, gap: 4, marginTop: -4 },
  suggestTitle: { color: colors.secondary, fontFamily: fonts.label, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' },
  suggestItem: { color: colors.sub, fontFamily: fonts.regular, fontSize: 13 },
});
