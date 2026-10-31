import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { campusApi, errorText, type ConnectionMode, type Me } from '@/api/campus';
import { modeUi } from '@/components/campus/Social';
import { ErrorState, LoadingRows, SignedOutState } from '@/components/campus/States';
import { Button, Header, Icon, PressScale, Screen, tap } from '@/components/ui';
import { invalidateCampus, useAction, useHostelOptions, useMe } from '@/hooks/useCampus';
import { useApp } from '@/state/AppState';
import { alpha, colors, fonts, radius } from '@/theme';

const MODES: ConnectionMode[] = ['friends', 'crew', 'date'];

/** Edit name, bio, connection mode and hostel (PATCH /v1/me). */
export default function EditProfile() {
  const me = useMe();
  if (!me.data) {
    return (
      <Screen tabBar={false}>
        <Header back title="Edit profile" />
        {me.signedOut ? <SignedOutState what="your profile" /> : me.error ? <ErrorState cause={me.cause} onRetry={me.reload} /> : <LoadingRows rows={4} />}
      </Screen>
    );
  }
  return <Form me={me.data} onSaved={(m) => me.mutate(m)} />;
}

function Form({ me, onSaved }: { me: Me; onSaved: (m: Me) => void }) {
  const { toast } = useApp();
  const hostelOptions = useHostelOptions();
  const [name, setName] = useState(me.display_name);
  const [bio, setBio] = useState(me.bio ?? '');
  const [mode, setMode] = useState<ConnectionMode | null>(me.connection_mode);
  const [hostel, setHostel] = useState<string | null>(me.hostel_zone_id);
  const save = useAction(() =>
    campusApi.updateMe({
      display_name: name.trim(),
      bio: bio.trim(),
      ...(mode ? { connection_mode: mode } : {}),
      ...(hostel ? { hostel_zone_id: hostel } : {}),
    }),
  );
  const hostels = hostelOptions.options;
  const submit = async () => {
    const r = await save.run();
    if (r) {
      onSaved(r);
      invalidateCampus('profile');
      toast('Profile saved', 'check-circle', colors.primary);
      router.back();
    }
  };
  return (
    <Screen tabBar={false}>
      <Header back title="Edit profile" />
      <Text style={styles.label}>Name</Text>
      <TextInput style={styles.input} value={name} onChangeText={setName} maxLength={40} placeholder="Your name" placeholderTextColor={colors.mute} />
      <Text style={styles.label}>Bio</Text>
      <TextInput style={[styles.input, { minHeight: 80, textAlignVertical: 'top' }]} value={bio} onChangeText={setBio} maxLength={160} multiline placeholder="Course, year, how you move" placeholderTextColor={colors.mute} />
      <Text style={styles.count}>{bio.length}/160</Text>
      <Text style={styles.label}>Connection mode</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {MODES.map((m) => {
          const ui = modeUi(m)!;
          const on = mode === m;
          return (
            <PressScale key={m} onPress={() => { tap(); setMode(m); }} style={[styles.chip, on && { borderColor: ui.color, backgroundColor: `${ui.color}18` }]} scaleTo={0.96} accessibilityRole="radio" accessibilityState={{ selected: on }}>
              <Icon name={ui.icon} size={16} color={on ? ui.color : colors.dim} />
              <Text style={[styles.chipText, on && { color: ui.color }]}>{ui.label}</Text>
            </PressScale>
          );
        })}
      </View>
      {hostels.length > 0 && (
        <>
          <Text style={styles.label}>Hostel</Text>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {hostels.map((h) => {
              const on = hostel === h.id;
              return (
                <PressScale key={h.id} onPress={() => { tap(); setHostel(h.id); }} style={[styles.chip, on && { borderColor: colors.primary, backgroundColor: alpha(colors.primary, 0.08) }]} scaleTo={0.96} accessibilityRole="radio" accessibilityState={{ selected: on }}>
                  <Text style={[styles.chipText, on && { color: colors.primary }]}>{h.label}</Text>
                </PressScale>
              );
            })}
          </View>
        </>
      )}
      {save.status === 'error' && <Text style={styles.err}>{errorText(save.error)}</Text>}
      <Button label={save.status === 'loading' ? 'Saving…' : 'Save'} iconLeft="check" disabled={save.status === 'loading' || !name.trim()} onPress={submit} style={{ marginTop: 20 }} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { color: colors.dim, fontFamily: fonts.label, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase', marginTop: 16, marginBottom: 6 },
  input: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, color: colors.text, fontFamily: fonts.regular, fontSize: 15 },
  count: { color: colors.mute, fontFamily: fonts.mono, fontSize: 10, textAlign: 'right', marginTop: 4 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1.5, borderColor: colors.line, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 9, backgroundColor: colors.card },
  chipText: { color: colors.sub, fontFamily: fonts.label, fontSize: 14, letterSpacing: 0.8, textTransform: 'uppercase' },
  err: { color: colors.coral, fontFamily: fonts.medium, fontSize: 13, marginTop: 12 },
});
