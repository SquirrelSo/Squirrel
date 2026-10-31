/**
 * "About you" — the profile-building fields in onboarding. Compulsory fields carry a pink
 * REQUIRED tag and block Continue; CGPA is marked OPTIONAL and never blocks. Errors show once a
 * field has been left (or Continue was tried), with the right keyboard for every input. The college
 * email is the sign-in address, shown rather than typed (Exercise accepts no other).
 */
import { forwardRef, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import type { Gender } from '@/api/campus/types';
import { Icon, tap } from '@/components/ui';
import { ageOn, dobToIso, formatDobInput, type DetailsErrors, type DetailsField, type DetailsForm } from '@/logic/profileValidation';
import { alpha, colors, fonts, radius } from '@/theme';

export const GENDERS: { id: Gender; label: string }[] = [
  { id: 'female', label: 'Woman' },
  { id: 'male', label: 'Man' },
  { id: 'non_binary', label: 'Non-binary' },
  { id: 'undisclosed', label: 'Prefer not to say' },
];
export const DEFAULT_COURSES = ['BS-MS', 'Integrated PhD', 'PhD', 'MSc', 'BSc', 'BTech'];
const OTHER = 'Other';

export function ProfileDetailsForm({ value, onChange, errors, showAll, courses }: { value: DetailsForm; onChange: (next: DetailsForm) => void; errors: DetailsErrors; showAll: boolean; courses: string[] }) {
  const [touched, setTouched] = useState<Partial<Record<DetailsField, boolean>>>({});
  const [otherCourse, setOtherCourse] = useState(() => !!value.course && !courses.includes(value.course));
  const refs = useRef<Partial<Record<DetailsField, TextInput | null>>>({});
  const set = (k: DetailsField) => (t: string) => onChange({ ...value, [k]: t });
  const blur = (k: DetailsField) => () => setTouched((x) => ({ ...x, [k]: true }));
  const err = (k: DetailsField) => (showAll || touched[k] ? errors[k] : undefined);
  const dob = dobToIso(value.date_of_birth);

  return (
    <View style={{ gap: 16 }}>
      <View style={styles.legend} accessibilityLabel="Fields marked required must be filled in. CGPA is optional.">
        <Tag kind="required" />
        <Text style={styles.legendText}>must be filled in · </Text>
        <Tag kind="optional" />
        <Text style={styles.legendText}>can be skipped</Text>
      </View>

      <Field label="Full name" required error={err('full_name')}>
        <Input ref={(r) => { refs.current.full_name = r; }} value={value.full_name} onChangeText={set('full_name')} onBlur={blur('full_name')} placeholder="As on your college ID" autoCapitalize="words" autoComplete="name" textContentType="name" returnKeyType="next" onSubmitEditing={() => refs.current.personal_email?.focus()} invalid={!!err('full_name')} />
      </Field>

      <Field label="Personal email" required error={err('personal_email')} help="We’ll use this if you ever lose access to your college email.">
        <Input ref={(r) => { refs.current.personal_email = r; }} value={value.personal_email} onChangeText={set('personal_email')} onBlur={blur('personal_email')} placeholder="you@gmail.com" keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" textContentType="emailAddress" returnKeyType="next" onSubmitEditing={() => refs.current.phone?.focus()} invalid={!!err('personal_email')} />
      </Field>

      <Field label="College email" required error={showAll ? errors.college_email : undefined} help="The address you signed in with.">
        <View style={[styles.input, styles.readOnly]} accessibilityLabel={`College email, ${value.college_email || 'not loaded'}`}>
          <Icon name="lock-outline" size={14} color={colors.dim} />
          <Text style={styles.readOnlyText} numberOfLines={1}>{value.college_email || '—'}</Text>
        </View>
      </Field>

      <Field label="Phone number" required error={err('phone')}>
        <View style={styles.phoneRow}>
          <View style={styles.prefix} accessibilityLabel="Country code plus 91">
            <Text style={styles.prefixText}>🇮🇳 +91</Text>
          </View>
          <Input ref={(r) => { refs.current.phone = r; }} value={value.phone} onChangeText={set('phone')} onBlur={blur('phone')} placeholder="98765 43210" keyboardType="phone-pad" autoComplete="tel" textContentType="telephoneNumber" maxLength={16} returnKeyType="next" onSubmitEditing={() => refs.current.date_of_birth?.focus()} invalid={!!err('phone')} style={{ flex: 1 }} accessibilityLabel="Phone number" />
        </View>
      </Field>

      <Field label="Gender" required error={err('gender')}>
        <View style={styles.chips} accessibilityRole="radiogroup">
          {GENDERS.map((g) => (
            <Chip key={g.id} label={g.label} on={value.gender === g.id} onPress={() => { onChange({ ...value, gender: g.id }); setTouched((x) => ({ ...x, gender: true })); }} />
          ))}
        </View>
      </Field>

      <Field label="Date of birth" required error={err('date_of_birth')} help={dob ? `You’re ${ageOn(dob, new Date())}.` : 'Never shown on your profile.'}>
        <Input ref={(r) => { refs.current.date_of_birth = r; }} value={value.date_of_birth} onChangeText={(t) => set('date_of_birth')(formatDobInput(t))} onBlur={blur('date_of_birth')} placeholder="DD/MM/YYYY" keyboardType="number-pad" maxLength={10} returnKeyType="done" invalid={!!err('date_of_birth')} style={{ width: 160 }} accessibilityLabel="Date of birth, day month year" />
      </Field>

      <Field label="Course" required error={err('course')}>
        <View style={styles.chips} accessibilityRole="radiogroup">
          {courses.map((c) => (
            <Chip key={c} label={c} on={!otherCourse && value.course === c} onPress={() => { setOtherCourse(false); onChange({ ...value, course: c }); setTouched((x) => ({ ...x, course: true })); }} />
          ))}
          <Chip label={OTHER} on={otherCourse} onPress={() => { setOtherCourse(true); onChange({ ...value, course: courses.includes(value.course) ? '' : value.course }); setTimeout(() => refs.current.course?.focus(), 50); }} />
        </View>
        {otherCourse && (
          <Input ref={(r) => { refs.current.course = r; }} value={value.course} onChangeText={set('course')} onBlur={blur('course')} placeholder="Your course" autoCapitalize="words" maxLength={60} invalid={!!err('course')} style={{ marginTop: 8 }} accessibilityLabel="Your course" />
        )}
      </Field>

      <Field label="CGPA" optional error={err('cgpa')} help="Only if you want to — it’s never shown on your public profile.">
        <Input ref={(r) => { refs.current.cgpa = r; }} value={value.cgpa} onChangeText={(t) => set('cgpa')(t.replace(',', '.').replace(/[^\d.]/g, ''))} onBlur={blur('cgpa')} placeholder="e.g. 8.4" keyboardType="decimal-pad" maxLength={5} invalid={!!err('cgpa')} style={{ width: 130 }} />
      </Field>
    </View>
  );
}

function Tag({ kind }: { kind: 'required' | 'optional' }) {
  return (
    <View style={[styles.tag, kind === 'required' ? styles.tagReq : styles.tagOpt]}>
      <Text style={[styles.tagText, { color: kind === 'required' ? colors.secondary : colors.dim }]}>{kind === 'required' ? 'Required' : 'Optional'}</Text>
    </View>
  );
}

function Field({ label, required, optional, error, help, children }: { label: string; required?: boolean; optional?: boolean; error?: string; help?: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 6 }} accessibilityLabel={`${label}${required ? ', required' : optional ? ', optional' : ''}`}>
      <View style={styles.labelRow}>
        <Text style={styles.label}>{label}</Text>
        {required && <Tag kind="required" />}
        {optional && <Tag kind="optional" />}
      </View>
      {children}
      {error ? (
        <View style={styles.errRow} accessibilityLiveRegion="polite">
          <Icon name="alert-circle-outline" size={13} color={colors.coral} />
          <Text style={styles.err}>{error}</Text>
        </View>
      ) : help ? (
        <Text style={styles.help}>{help}</Text>
      ) : null}
    </View>
  );
}

const Input = forwardRef<TextInput, TextInputProps & { invalid?: boolean }>(function Input({ invalid, style, ...p }, ref) {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={colors.mute}
      {...p}
      onFocus={(e) => { setFocused(true); p.onFocus?.(e); }}
      onBlur={(e) => { setFocused(false); p.onBlur?.(e); }}
      style={[styles.input, focused && { borderColor: colors.primary }, invalid && { borderColor: colors.coral }, style]}
    />
  );
});

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={() => { tap(); onPress(); }} style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && { opacity: 0.75 }]} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={label}>
      {on && <Icon name="check" size={14} color={colors.primary} />}
      <Text style={[styles.chipText, on && { color: colors.primary }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  legend: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  legendText: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { color: colors.text, fontFamily: fonts.label, fontSize: 15, letterSpacing: 0.6, textTransform: 'uppercase' },
  tag: { borderRadius: radius.pill, borderWidth: 1, paddingHorizontal: 7, paddingVertical: 1 },
  tagReq: { borderColor: alpha(colors.secondary, 0.55), backgroundColor: alpha(colors.secondary, 0.08) },
  tagOpt: { borderColor: colors.lineHi },
  tagText: { fontFamily: fonts.labelBold, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' },
  input: { color: colors.text, fontFamily: fonts.regular, fontSize: 16, backgroundColor: colors.card, borderWidth: 1.5, borderColor: colors.line, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 11, minHeight: 46 },
  phoneRow: { flexDirection: 'row', gap: 8 },
  prefix: { justifyContent: 'center', paddingHorizontal: 12, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.line, backgroundColor: colors.cardHi },
  prefixText: { color: colors.text, fontFamily: fonts.semibold, fontSize: 15 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 40, borderRadius: radius.pill, borderWidth: 1.5, borderColor: colors.line, backgroundColor: colors.card, paddingHorizontal: 14, paddingVertical: 8 },
  chipOn: { borderColor: colors.primary, backgroundColor: alpha(colors.primary, 0.08) },
  chipText: { color: colors.sub, fontFamily: fonts.label, fontSize: 15, letterSpacing: 0.6, textTransform: 'uppercase' },
  errRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  err: { flex: 1, color: colors.coral, fontFamily: fonts.medium, fontSize: 12 },
  help: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12 },
  readOnly: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.cardHi },
  readOnlyText: { flex: 1, color: colors.sub, fontFamily: fonts.regular, fontSize: 16 },
});
