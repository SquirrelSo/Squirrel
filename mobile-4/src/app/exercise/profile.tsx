import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { EXERCISE_API_CONFIGURED } from '@/api/config';
import { exerciseApi, hasCoachDetails, type CoachDetails, type ExerciseProfile } from '@/api/exercise';
import { RemoteStatus, StatTile } from '@/components/ExerciseParts';
import { Button, Card, Display, EmptyState, Header, Kicker, Screen, Segmented, tap } from '@/components/ui';
import { invalidateExercise, useExerciseProfile, useExerciseUser } from '@/hooks/useExercise';
import { useApp } from '@/state/AppState';
import { colors, fonts, radius } from '@/theme';

const GENDERS = ['female', 'male', 'other'] as const;
const GENDER_LABELS = { female: 'Female', male: 'Male', other: 'Other' };
type Gender = (typeof GENDERS)[number];

/**
 * Coach profile. It belongs to the signed-in account: the backend serves it only with that
 * account's token. Signed out → sign in first. Signed in without coach details (an account made
 * in the app starts with name and email only) → fill them in. Otherwise view or edit them.
 */
export default function ExerciseProfileScreen() {
  const user = useExerciseUser();
  if (!EXERCISE_API_CONFIGURED) {
    return (
      <Screen tabBar={false}>
        <Header back title="Coach profile" />
        <EmptyState title="Coach not connected" body="Set EXPO_PUBLIC_EXERCISE_API_URL in mobile/.env and restart the app." />
      </Screen>
    );
  }
  if (!user) {
    return (
      <Screen tabBar={false}>
        <Header back title="Coach profile" />
        <EmptyState
          title="Sign in to use the coach"
          body="Your coach profile, workouts and reports belong to your Squirrel Social account, so only you can see them."
          action="Sign in or create an account"
          onAction={() => router.push('/sign-in')}
        />
      </Screen>
    );
  }
  return <AccountProfile uid={user.user_id} />;
}

function AccountProfile({ uid }: { uid: string }) {
  const p = useExerciseProfile(uid);
  const [editing, setEditing] = useState(false);
  if (!p.data) {
    return (
      <Screen tabBar={false}>
        <Header back title="Coach profile" />
        <RemoteStatus loading={p.loading} error={p.error} hasData={false} onRetry={p.reload} label="profile" />
      </Screen>
    );
  }
  const saved = () => {
    invalidateExercise(uid);
    setEditing(false);
    p.reload();
  };
  if (editing || !hasCoachDetails(p.data)) {
    return <DetailsForm uid={uid} profile={p.data} onSaved={saved} onCancel={hasCoachDetails(p.data) ? () => setEditing(false) : undefined} />;
  }
  return <ViewProfile profile={p.data} onEdit={() => setEditing(true)} />;
}

function ViewProfile({ profile, onEdit }: { profile: ExerciseProfile & CoachDetails; onEdit: () => void }) {
  const bmi = profile.weight_kg / (profile.height_cm / 100) ** 2;
  return (
    <Screen tabBar={false}>
      <Header back title="Coach profile" />
      <Kicker>Your coach profile</Kicker>
      <Display size={32} style={{ marginTop: 10 }}>{profile.first_name} {profile.last_name}</Display>
      <View style={styles.tiles}>
        <StatTile value={`${profile.height_cm}`} label="Height cm" />
        <StatTile value={`${profile.weight_kg}`} label="Weight kg" />
        <StatTile value={bmi.toFixed(1)} label="BMI" color={colors.primary} />
      </View>
      <Card style={{ marginTop: 12, gap: 6 }}>
        <Row k="Gender" v={profile.gender} />
        <Row k="Date of birth" v={profile.date_of_birth} />
        <Row k="Email" v={profile.email} />
        <Row k="Mobile" v={profile.mobile} />
        <Row k="Created" v={profile.created_at.slice(0, 10)} />
      </Card>
      <Text style={styles.note}>Only you can see this: it belongs to the account you’re signed in with.</Text>
      <Button label="Edit details" variant="secondary" size="md" onPress={onEdit} style={{ marginTop: 16 }} />
    </Screen>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
      <Text style={styles.k}>{k}</Text>
      <Text style={styles.v} numberOfLines={1}>{v}</Text>
    </View>
  );
}

type Form = { height_cm: string; weight_kg: string; date_of_birth: string; mobile: string };

/** Client checks mirror the backend's CoachProfile validation, so most mistakes never reach it. */
function validate(f: Form): string | null {
  const h = Number(f.height_cm);
  const w = Number(f.weight_kg);
  // Same bounds as the backend (profiles/vocab.py HEIGHT_CM, WEIGHT_KG; check_date_of_birth).
  if (!(h >= 50 && h <= 272)) return 'Height must be between 50 and 272 cm.';
  if (!(w >= 20 && w <= 400)) return 'Weight must be between 20 and 400 kg.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date_of_birth) || Number.isNaN(Date.parse(f.date_of_birth))) return 'Date of birth must be YYYY-MM-DD.';
  if (f.date_of_birth < '1900-01-01' || f.date_of_birth > new Date().toISOString().slice(0, 10)) return 'Date of birth must be between 1900 and today.';
  if (f.mobile.trim().length < 3) return 'Enter your mobile number.';
  return null;
}

const asText = (v: number | string | undefined) => (v == null ? '' : String(v));

function DetailsForm({ uid, profile, onSaved, onCancel }: { uid: string; profile: ExerciseProfile; onSaved: () => void; onCancel?: () => void }) {
  const { toast } = useApp();
  const [f, setF] = useState<Form>({
    height_cm: asText(profile.height_cm),
    weight_kg: asText(profile.weight_kg),
    date_of_birth: asText(profile.date_of_birth),
    mobile: asText(profile.mobile),
  });
  const [gender, setGender] = useState<Gender>(GENDERS.includes(profile.gender as Gender) ? (profile.gender as Gender) : 'female');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof Form) => (v: string) => setF((s) => ({ ...s, [k]: v }));

  const save = async () => {
    const bad = validate(f);
    if (bad) return setError(bad);
    setBusy(true);
    setError(null);
    try {
      await exerciseApi.saveProfile(uid, {
        gender,
        height_cm: Number(f.height_cm),
        weight_kg: Number(f.weight_kg),
        date_of_birth: f.date_of_birth,
        mobile: f.mobile.trim(),
      });
      tap('success');
      toast('Coach profile saved', 'check', colors.primary);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the profile.');
    } finally {
      setBusy(false);
    }
  };

  const input = (k: keyof Form, placeholder: string, extra: Partial<React.ComponentProps<typeof TextInput>> = {}) => (
    <TextInput style={styles.input} value={f[k]} onChangeText={set(k)} placeholder={placeholder} placeholderTextColor={colors.mute} {...extra} />
  );

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen tabBar={false}>
        <Header back title="Coach profile" />
        <Display size={28} style={{ marginTop: 6 }}>{profile.first_name} {profile.last_name}</Display>
        <Text style={styles.note}>The coach uses your height and weight to judge range of motion. They’re saved to your account.</Text>
        <View style={{ gap: 10, marginTop: 14 }}>
          <Segmented items={GENDERS} labels={GENDER_LABELS} value={gender} onChange={setGender} />
          <View style={styles.pair}>
            <View style={{ flex: 1 }}>{input('height_cm', 'Height (cm)', { keyboardType: 'decimal-pad' })}</View>
            <View style={{ flex: 1 }}>{input('weight_kg', 'Weight (kg)', { keyboardType: 'decimal-pad' })}</View>
          </View>
          {input('date_of_birth', 'Date of birth (YYYY-MM-DD)', { keyboardType: 'numbers-and-punctuation', maxLength: 10 })}
          {input('mobile', 'Mobile', { keyboardType: 'phone-pad', autoComplete: 'tel' })}
          {error && <Text style={styles.error}>{error}</Text>}
          <Button label={busy ? 'Saving…' : 'Save profile'} icon="arrow-right" disabled={busy} onPress={save} />
          {onCancel && <Button label="Cancel" variant="secondary" size="md" disabled={busy} onPress={onCancel} />}
        </View>
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  input: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 13, color: colors.text, fontFamily: fonts.regular, fontSize: 15 },
  pair: { flexDirection: 'row', gap: 10 },
  note: { color: colors.dim, fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, marginTop: 10 },
  error: { color: colors.coral, fontFamily: fonts.semibold, fontSize: 13 },
  dev: { color: colors.dim, fontFamily: fonts.mono, fontSize: 11 },
  id: { color: colors.text, fontFamily: fonts.mono, fontSize: 14, marginTop: 4 },
  tiles: { flexDirection: 'row', gap: 8, marginTop: 14 },
  k: { color: colors.dim, fontFamily: fonts.regular, fontSize: 13 },
  v: { color: colors.text, fontFamily: fonts.semibold, fontSize: 13, flexShrink: 1 },
});
