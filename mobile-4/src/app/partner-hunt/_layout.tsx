import { Stack } from 'expo-router';
import { FeatureGate } from '@/components/Locked';
import { PartnerHuntLocked } from '@/components/PartnerHuntLocked';
import { colors } from '@/theme';

/**
 * Partner Hunt: Find your buddy → Preferences → Matching → Buddy profiles → Connect.
 * While Partner Hunt is locked, every route in this folder (including deep links)
 * renders the locked screen instead of its content.
 */
export default function PartnerHuntLayout() {
  return (
    <FeatureGate feature="partnerHunt" fallback={<PartnerHuntLocked />}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: 'slide_from_right' }} />
    </FeatureGate>
  );
}
