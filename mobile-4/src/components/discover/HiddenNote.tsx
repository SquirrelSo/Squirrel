/**
 * Why a Discover section or the bubble list is held back (`hidden_reason`), and the fix: Open to Meet
 * off → the app's Open to Meet switch right here; location unknown / not in your bubble → your bubble;
 * anything fail-closed (block list unchecked, section failed) → Retry.
 */
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { OpenToMeetToggle } from '@/components/campus/Social';
import { EmptyNote } from '@/components/campus/States';
import { hiddenInfo } from '@/logic/discover';
import { colors, fonts } from '@/theme';

export function HiddenNote({ reason, onRetry, onOpenToMeet, onBubble, compact }: { reason: string | null | undefined; onRetry: () => void; onOpenToMeet?: (on: boolean) => void; onBubble?: () => void; compact?: boolean }) {
  const info = hiddenInfo(reason);
  if (!info) return null;
  if (info.action === 'open_to_meet') {
    return (
      <View style={{ gap: 8 }}>
        <Text style={{ color: colors.dim, fontFamily: fonts.regular, fontSize: 13, lineHeight: 18 }}>{info.body}</Text>
        <OpenToMeetToggle value={false} onChange={onOpenToMeet} />
      </View>
    );
  }
  if (info.action === 'bubble') {
    return <EmptyNote icon="map-marker-question-outline" title={info.title} body={info.body} action={onBubble ? 'Join your bubble' : 'Open your bubble'} onAction={onBubble ?? (() => router.push('/bubble'))} />;
  }
  return <EmptyNote icon={compact ? 'information-outline' : 'shield-alert-outline'} title={info.title} body={info.body} action="Retry" onAction={onRetry} />;
}
