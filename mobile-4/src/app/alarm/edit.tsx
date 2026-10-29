/** NEW / EDIT MOVEMENT ALARM — time, challenge, how much, on/off, delete. */
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { AmountPicker, ChallengePicker, TimePicker } from '@/components/alarm/AlarmParts';
import { Button, Card, Header, Icon, Kicker, Screen } from '@/components/ui';
import { AlarmService, type AlarmDraft } from '@/features/alarm/AlarmService';
import { challengeById, challengeSummary, type ChallengeId } from '@/logic/movementChallenges';
import { useApp } from '@/state/AppState';
import { colors, fonts, radius } from '@/theme';

const DEFAULT: AlarmDraft = { time: { hour: 7, minute: 30 }, enabled: true, challenge: 'dance', amount: 20, label: null };

export default function EditAlarm() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { toast } = useApp();
  const [draft, setDraft] = useState<AlarmDraft | null>(id ? null : DEFAULT);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!id) return;
    void AlarmService.get(id).then((a) => (a ? setDraft(a) : setMissing(true)));
  }, [id]);

  if (missing) {
    return (
      <Screen tabBar={false}>
        <Header back title="Alarm" />
        <Text style={styles.hint}>That alarm doesn’t exist any more.</Text>
        <Button label="Back to alarms" variant="secondary" size="md" onPress={() => router.replace('/alarm')} style={{ marginTop: 16 }} />
      </Screen>
    );
  }
  if (!draft) return <Screen tabBar={false}><Header back title="Alarm" /></Screen>;

  const c = challengeById(draft.challenge);
  const setChallenge = (cid: ChallengeId) => setDraft((d) => d && { ...d, challenge: cid, amount: challengeById(cid).defaultAmount });

  const submit = async () => {
    setBusy(true);
    try {
      const { permission } = await AlarmService.save(draft);
      if (permission === 'denied') toast('Saved, but notifications are off — it can’t ring until you allow them in Settings.', 'bell-off-outline', colors.coral);
      else toast(draft.enabled ? `Alarm set · ${AlarmService.label(draft).full}` : 'Alarm saved (off)', 'alarm-check', colors.primary);
      router.back();
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!id) return;
    await AlarmService.remove(id);
    toast('Alarm deleted', 'delete-outline', colors.dim);
    router.back();
  };

  return (
    <Screen tabBar={false}>
      <Header back title={id ? 'Edit alarm' : 'New alarm'} />
      <Kicker style={{ marginTop: 6 }}>Wake-up time</Kicker>
      <View style={{ marginTop: 8 }}>
        <TimePicker value={draft.time} onChange={(time) => setDraft((d) => d && { ...d, time })} />
      </View>

      <Kicker style={{ marginTop: 20 }}>Challenge</Kicker>
      <View style={{ marginTop: 10 }}>
        <ChallengePicker value={draft.challenge} onChange={setChallenge} />
      </View>
      <Text style={styles.how}>{c.howTo} {c.stopRule}</Text>

      <Kicker style={{ marginTop: 18 }}>{c.unit === 'sec' ? 'For how long' : 'How many'}</Kicker>
      <View style={{ marginTop: 10 }}>
        <AmountPicker challenge={draft.challenge} value={draft.amount} onChange={(amount) => setDraft((d) => d && { ...d, amount })} />
      </View>

      <Kicker style={{ marginTop: 18 }}>Label (optional)</Kicker>
      <TextInput style={styles.input} value={draft.label ?? ''} onChangeText={(label) => setDraft((d) => d && { ...d, label })} maxLength={30} placeholder="e.g. 8 AM lab" placeholderTextColor={colors.mute} accessibilityLabel="Alarm label" />

      <Card style={styles.row}>
        <Icon name="alarm" size={20} color={draft.enabled ? colors.primary : colors.dim} />
        <Text style={styles.rowText}>Alarm on</Text>
        <Switch value={draft.enabled} onValueChange={(enabled) => setDraft((d) => d && { ...d, enabled })} trackColor={{ false: colors.lineHi, true: colors.primaryDeep }} thumbColor={draft.enabled ? colors.primary : colors.dim} accessibilityLabel="Alarm on" />
      </Card>

      <Card style={styles.summary}>
        <Text style={styles.sumKicker}>Every day at {AlarmService.label(draft).full}</Text>
        <Text style={styles.sumText}>{challengeSummary(draft.challenge, draft.amount)} to switch it off</Text>
      </Card>

      <Button label={busy ? 'Saving…' : id ? 'Save alarm' : 'Set alarm'} iconLeft="alarm-check" disabled={busy} onPress={submit} style={{ marginTop: 16 }} />
      <Button
        label="Practice this challenge"
        variant="secondary"
        size="md"
        iconLeft="play-circle-outline"
        onPress={() => router.push({ pathname: '/alarm/ring/[id]', params: { id: 'practice', challenge: draft.challenge, amount: String(draft.amount) } })}
        style={{ marginTop: 10 }}
      />
      {id &&
        (confirmDelete ? (
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
            <Button label="Delete" variant="secondary" size="md" iconLeft="delete-outline" onPress={remove} style={{ flex: 1 }} accessibilityLabel="Confirm delete alarm" />
            <Button label="Keep" variant="secondary" size="md" onPress={() => setConfirmDelete(false)} style={{ flex: 1 }} />
          </View>
        ) : (
          <Text style={styles.delete} onPress={() => setConfirmDelete(true)} accessibilityRole="button">Delete alarm</Text>
        ))}
      {Platform.OS === 'web' && <Text style={styles.hint}>{AlarmService.scheduler.note}</Text>}
    </Screen>
  );
}

const styles = StyleSheet.create({
  how: { color: colors.dim, fontFamily: fonts.regular, fontSize: 13, lineHeight: 18, marginTop: 10 },
  input: { marginTop: 8, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, color: colors.text, fontFamily: fonts.regular, fontSize: 15 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18 },
  rowText: { flex: 1, color: colors.text, fontFamily: fonts.semibold, fontSize: 15 },
  summary: { marginTop: 12, gap: 2, borderColor: colors.primary },
  sumKicker: { color: colors.primary, fontFamily: fonts.label, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' },
  sumText: { color: colors.text, fontFamily: fonts.semibold, fontSize: 15 },
  delete: { color: colors.coral, fontFamily: fonts.semibold, fontSize: 14, textAlign: 'center', marginTop: 16, paddingVertical: 6 },
  hint: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, marginTop: 12 },
});
