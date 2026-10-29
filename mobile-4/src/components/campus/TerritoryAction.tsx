/**
 * Claim / Steal / Defend. Shows an action only when the backend's availability says it's
 * allowed; otherwise explains why (from the backend's `reason`). Every attempt has loading,
 * success and failure states, sends an idempotency key, and reconciles with the server's
 * returned territory — the UI never assumes it won.
 */
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { campusApi, errorCode, errorText, type ActionAvailability, type TerritoryAction, type TerritoryActionResult } from '@/api/campus';
import { Button, Icon, tap } from '@/components/ui';
import { untilTime } from '@/components/campus/territoryUi';
import { actionKey, invalidateCampus, useAction } from '@/hooks/useCampus';
import { upsertTerritory } from '@/state/territoryStore';
import { showCapture } from '@/components/game/CaptureMoment';
import { colors, fonts, radius } from '@/theme';

const COPY: Record<TerritoryAction, { label: string; icon: React.ComponentProps<typeof Icon>['name']; done: string; variant: 'primary' | 'accent' | 'gold' }> = {
  claim: { label: 'Claim Zone', icon: 'flag-plus', done: 'Claimed', variant: 'primary' },
  steal: { label: 'Steal Zone', icon: 'sword-cross', done: 'Stolen', variant: 'accent' },
  defend: { label: 'Defend Territory', icon: 'shield-check', done: 'Defended', variant: 'gold' },
};

export function TerritoryActionButton({
  zoneId,
  zoneName,
  action,
  availability,
  ownerName,
  onDone,
  onFailed,
}: {
  zoneId: string;
  zoneName: string;
  action: TerritoryAction;
  availability: ActionAvailability;
  ownerName?: string | null;
  onDone?: (r: TerritoryActionResult) => void;
  /** Called after a failed attempt so the parent re-reads the zone (ownership may have moved). */
  onFailed?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const act = useAction((key: string) => campusApi.territoryAction(zoneId, action, key));
  const copy = COPY[action];

  // A confirmation expires if the user doesn't follow through.
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 5000);
    return () => clearTimeout(t);
  }, [confirming]);

  const go = async () => {
    // Stealing takes a zone from a person — ask once.
    if (action === 'steal' && !confirming) {
      tap();
      setConfirming(true);
      return;
    }
    setConfirming(false);
    tap('impact');
    const r = await act.run(actionKey(`${action}:${zoneId}`));
    if (r) {
      upsertTerritory(r.territory); // server truth
      invalidateCampus('me');
      invalidateCampus('board');
      tap('success');
      showCapture(action, zoneName); // short game moment, only after the backend confirms
      onDone?.(r);
    } else {
      onFailed?.();
    }
  };

  if (act.status === 'success') {
    return (
      <View style={[styles.result, { borderColor: colors.primary }]} accessibilityLiveRegion="polite">
        <Icon name="check-decagram" size={18} color={colors.primary} />
        <Text style={[styles.resultText, { color: colors.primary }]}>{copy.done} · confirmed by the server</Text>
      </View>
    );
  }

  if (!availability.allowed) {
    // Nothing to press — just the backend's reason (e.g. "Run through CC1 to unlock a claim").
    return (
      <View style={styles.reason}>
        <Icon name={availability.code === 'shielded' ? 'shield-lock-outline' : 'information-outline'} size={15} color={colors.dim} />
        <Text style={styles.reasonText}>
          {availability.reason ?? 'Not available right now.'}
          {availability.code === 'shielded' && availability.expires_at ? ` Shield drops in ${untilTime(availability.expires_at)}.` : ''}
        </Text>
      </View>
    );
  }

  const failed = act.status === 'error';
  const conflict = failed && (errorCode(act.error) === 'not_eligible' || errorCode(act.error) === 'already_owned' || errorCode(act.error) === 'shielded');
  return (
    <View style={{ gap: 6 }}>
      <Button
        label={act.status === 'loading' ? `${copy.label}…` : confirming ? `Tap again to steal from ${ownerName?.split(' ')[0] ?? 'them'}` : failed ? `Retry · ${copy.label}` : copy.label}
        iconLeft={act.status === 'loading' ? undefined : copy.icon}
        variant={copy.variant}
        size="md"
        disabled={act.status === 'loading'}
        onPress={go}
        accessibilityLabel={`${copy.label}: ${zoneName}`}
      />
      {act.status === 'loading' && (
        <View style={styles.row}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={styles.reasonText}>Waiting for the server…</Text>
        </View>
      )}
      {availability.expires_at && act.status === 'idle' && <Text style={styles.expiry}>Eligible for {untilTime(availability.expires_at)}</Text>}
      {failed && (
        <View style={[styles.result, { borderColor: colors.coral }]} accessibilityLiveRegion="polite">
          <Icon name="alert-circle-outline" size={16} color={colors.coral} />
          <Text style={[styles.resultText, { color: colors.coral, textTransform: 'none', fontFamily: fonts.medium }]}>
            {conflict ? `${errorText(act.error)} The zone was refreshed.` : errorText(act.error)}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  reason: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', backgroundColor: colors.cardHi, borderRadius: radius.md, padding: 10 },
  reasonText: { flex: 1, color: colors.dim, fontFamily: fonts.regular, fontSize: 12, lineHeight: 17 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center' },
  expiry: { color: colors.dim, fontFamily: fonts.mono, fontSize: 10, textAlign: 'center' },
  result: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1.5, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 9 },
  resultText: { flex: 1, fontFamily: fonts.label, fontSize: 13, letterSpacing: 0.6, textTransform: 'uppercase' },
});
