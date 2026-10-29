import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { campusApi, errorText, type Crew } from '@/api/campus';
import { Button, tap } from '@/components/ui';
import { invalidateCampus, useAction } from '@/hooks/useCampus';
import { useApp } from '@/state/AppState';
import { colors, fonts, radius } from '@/theme';

/**
 * Join / Leave with loading, success and failure. Shows the server's membership after the
 * call (not an optimistic guess), and asks once before leaving.
 */
export function CrewJoinButton({ crew, compact, onChanged }: { crew: Crew; compact?: boolean; onChanged?: (c: Crew) => void }) {
  const { toast } = useApp();
  const [membership, setMembership] = useState(crew.my_membership);
  const [confirm, setConfirm] = useState(false);
  const [seen, setSeen] = useState(crew.my_membership);
  if (seen !== crew.my_membership) {
    setSeen(crew.my_membership);
    setMembership(crew.my_membership);
  }
  const act = useAction((join: boolean) => (join ? campusApi.joinCrew(crew.id) : campusApi.leaveCrew(crew.id)));
  const member = !!membership;
  const go = async () => {
    if (member && !confirm) {
      tap();
      setConfirm(true);
      return;
    }
    setConfirm(false);
    tap();
    const r = await act.run(!member);
    if (r) {
      setMembership(r.my_membership);
      invalidateCampus('crew');
      invalidateCampus('me');
      toast(r.my_membership ? `You joined ${r.name}` : `You left ${r.name}`, r.my_membership ? 'account-group' : 'exit-run', r.my_membership ? colors.primary : colors.dim);
      onChanged?.(r);
    } else {
      toast(errorText(act.lastError()), 'alert-circle-outline', colors.coral);
    }
  };
  if (compact) {
    return (
      <Pressable onPress={go} disabled={act.status === 'loading' || membership === 'owner'} style={[styles.pill, member ? styles.pillOn : styles.pillOff]} accessibilityRole="button" accessibilityLabel={member ? `Leave ${crew.name}` : `Join ${crew.name}`}>
        {act.status === 'loading' ? (
          <ActivityIndicator size="small" color={member ? colors.primary : colors.onPrimary} />
        ) : (
          <Text style={[styles.pillText, { color: member ? colors.primary : colors.onPrimary }]}>{membership === 'owner' ? 'Owner' : confirm ? 'Leave?' : member ? 'Joined' : 'Join'}</Text>
        )}
      </Pressable>
    );
  }
  return (
    <Button
      label={act.status === 'loading' ? (member ? 'Leaving…' : 'Joining…') : membership === 'owner' ? 'You run this crew' : confirm ? 'Tap again to leave' : member ? 'Joined · Leave crew' : 'Join crew'}
      variant={member ? 'secondary' : 'primary'}
      iconLeft={member ? 'check' : 'account-plus'}
      disabled={act.status === 'loading' || membership === 'owner'}
      onPress={go}
    />
  );
}

const styles = StyleSheet.create({
  pill: { minWidth: 76, alignItems: 'center', borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 8 },
  pillOn: { borderWidth: 1.5, borderColor: colors.primary },
  pillOff: { backgroundColor: colors.primary },
  pillText: { fontFamily: fonts.labelBold, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' },
});
