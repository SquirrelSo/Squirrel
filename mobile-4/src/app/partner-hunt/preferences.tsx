/**
 * PARTNER HUNT · PREFERENCES — built from the server's `options` (labels and order as sent), sent back
 * as keys only. Saving is allowed while still locked, so you're on boards the moment you're in.
 */
import { useState } from 'react';
import { StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { errorText } from '@/api/campus';
import { partnerHuntApi, type PartnerPreferences } from '@/api/partnerHunt';
import { OptionChips } from '@/components/partnerHunt/Parts';
import { ErrorState, LoadingRows } from '@/components/campus/States';
import { Button, Display, Header, Kicker, Screen, SectionHeader, tap } from '@/components/ui';
import { invalidatePartnerHunt, usePartnerHuntUser, usePartnerStatus } from '@/hooks/usePartnerHunt';
import { preferencesBody, preferencesDraft, preferencesProblems, toggleKey } from '@/logic/partnerHunt';
import { useApp } from '@/state/AppState';
import { colors, fonts, radius } from '@/theme';

export default function PreferencesScreen() {
  const { userId } = usePartnerHuntUser();
  const status = usePartnerStatus();
  const s = status.data;
  if (!s) {
    return (
      <Screen tabBar={false}>
        <Header back title="Preferences" />
        {status.cause ? <ErrorState cause={status.cause} onRetry={status.reload} /> : <LoadingRows rows={4} height={70} />}
      </Screen>
    );
  }
  return <Form key={userId ?? ''} userId={userId!} initial={preferencesDraft(s)} options={s.options} />;
}

function Form({ userId, initial, options }: { userId: string; initial: PartnerPreferences; options: NonNullable<ReturnType<typeof usePartnerStatus>['data']>['options'] }) {
  const { toast } = useApp();
  const [p, setP] = useState<PartnerPreferences>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const problems = preferencesProblems(p, options);
  const set = (patch: Partial<PartnerPreferences>) => setP((x) => ({ ...x, ...patch }));
  const age = (k: 'partner_age_min' | 'partner_age_max', d: number) => {
    tap('select');
    set({ [k]: Math.min(options.partner_age.max, Math.max(options.partner_age.min, p[k] + d)) });
  };

  const save = async () => {
    setTried(true);
    if (problems.length) return;
    tap('impact');
    setSaving(true);
    setError(null);
    try {
      await partnerHuntApi.savePreferences(userId, preferencesBody(p));
      invalidatePartnerHunt();
      toast('Preferences saved', 'check-circle', colors.primary);
      router.back();
    } catch (e) {
      setSaving(false);
      setError(errorText(e));
    }
  };

  return (
    <Screen tabBar={false}>
      <Header back title="" />
      <Kicker>Partner Hunt</Kicker>
      <Display size={34} style={{ marginTop: 4 }}>Your preferences</Display>

      <View style={styles.switchRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>Show me to matches</Text>
          <Text style={styles.small}>You only see the board while others can see you.</Text>
        </View>
        <Switch value={p.visible} onValueChange={(v) => set({ visible: v })} trackColor={{ false: colors.lineHi, true: colors.primaryDeep }} thumbColor={p.visible ? colors.primary : colors.dim} accessibilityLabel="Show me to matches" />
      </View>

      <SectionHeader title="What you train" />
      <OptionChips options={options.activities} selected={p.activities} onToggle={(k) => { tap('select'); set({ activities: toggleKey(p.activities, k) }); }} />

      <SectionHeader title="When" />
      <OptionChips options={options.times} selected={p.preferred_times} onToggle={(k) => { tap('select'); set({ preferred_times: toggleKey(p.preferred_times, k) }); }} />

      <SectionHeader title="How you’d meet" />
      <OptionChips options={options.modes} selected={[p.mode]} onToggle={(k) => { tap('select'); set({ mode: k }); }} />
      {p.mode !== 'remote' && (
        <TextInput style={[styles.input, { marginTop: 10 }]} value={p.city ?? ''} onChangeText={(t) => set({ city: t })} maxLength={60} placeholder="Your city, e.g. Kalyani" placeholderTextColor={colors.mute} accessibilityLabel="Your city" />
      )}

      <SectionHeader title="Partner" />
      <Text style={[styles.small, { marginBottom: 8 }]}>Leave genders empty for anyone. Naming any hides people who haven’t said.</Text>
      <OptionChips options={options.genders} selected={p.partner_genders} onToggle={(k) => { tap('select'); set({ partner_genders: toggleKey(p.partner_genders, k) }); }} />
      <View style={styles.ages}>
        <AgeStepper label="From" value={p.partner_age_min} onMinus={() => age('partner_age_min', -1)} onPlus={() => age('partner_age_min', 1)} />
        <AgeStepper label="To" value={p.partner_age_max} onMinus={() => age('partner_age_max', -1)} onPlus={() => age('partner_age_max', 1)} />
      </View>

      {tried && problems.map((m) => <Text key={m} style={styles.err}>{m}</Text>)}
      {!!error && <Text style={styles.err}>{error}</Text>}
      <Button label={saving ? 'Saving…' : 'Save preferences'} iconLeft="check" disabled={saving} onPress={save} style={{ marginTop: 18 }} />
    </Screen>
  );
}

function AgeStepper({ label, value, onMinus, onPlus }: { label: string; value: number; onMinus: () => void; onPlus: () => void }) {
  return (
    <View style={styles.stepper} accessibilityLabel={`${label} age ${value}`}>
      <Text style={styles.small}>{label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Button label="−" size="sm" variant="secondary" onPress={onMinus} />
        <Text style={styles.ageValue}>{value}</Text>
        <Button label="+" size="sm" variant="secondary" onPress={onPlus} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 14 },
  label: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 15, letterSpacing: 0.6, textTransform: 'uppercase' },
  small: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, lineHeight: 17 },
  input: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, backgroundColor: colors.card, color: colors.text, fontFamily: fonts.medium, fontSize: 15, paddingHorizontal: 12, paddingVertical: 11 },
  ages: { flexDirection: 'row', gap: 12, marginTop: 12 },
  stepper: { flex: 1, gap: 6, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: 10 },
  ageValue: { color: colors.text, fontFamily: fonts.display, fontSize: 26, minWidth: 34, textAlign: 'center' },
  err: { color: colors.coral, fontFamily: fonts.medium, fontSize: 13, marginTop: 8 },
});
