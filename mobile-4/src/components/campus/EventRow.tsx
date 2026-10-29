import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { EventSummary, EventType } from '@/api/campus';
import { Icon, PressScale } from '@/components/ui';
import { formatEventDate } from '@/logic/format';
import { alpha, colors, fonts, radius } from '@/theme';
import { useLocks } from '@/components/Locked';

export const EVENT_TYPE: Record<string, { label: string; icon: React.ComponentProps<typeof Icon>['name']; color: string }> = {
  run: { label: 'Run', icon: 'run-fast', color: colors.primary },
  walk: { label: 'Walk', icon: 'walk', color: colors.green },
  study_break_walk: { label: 'Study break walk', icon: 'coffee-outline', color: colors.secondary },
  territory_battle: { label: 'Territory battle', icon: 'sword-cross', color: colors.secondary },
  weekend_war: { label: 'Weekend War', icon: 'flag-variant', color: colors.orange },
  social: { label: 'Social', icon: 'party-popper', color: colors.purple },
};
export const eventType = (t: EventType) => EVENT_TYPE[t] ?? { label: String(t).replace(/_/g, ' '), icon: 'calendar-star' as const, color: colors.blue };

export function EventRow({ event: e }: { event: EventSummary }) {
  const locks = useLocks();
  const t = eventType(e.type);
  return (
    <PressScale onPress={locks.guard('events', () => router.push({ pathname: '/event/[id]', params: { id: e.id } }))} style={[styles.row, e.my_rsvp === 'going' && { borderColor: alpha(colors.primary, 0.45) }]} scaleTo={0.985} accessibilityLabel={`${e.title}, ${formatEventDate(e.starts_at)}`}>
      <View style={[styles.icon, { borderColor: t.color }]}>
        <Icon name={t.icon} size={22} color={t.color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.type, { color: t.color }]}>{t.label}</Text>
        <Text style={styles.title} numberOfLines={1}>{e.title}</Text>
        <Text style={styles.meta} numberOfLines={1}>
          {formatEventDate(e.starts_at)} · {e.location.name}
        </Text>
        {e.territory_challenge && (
          <Text style={[styles.meta, { color: colors.secondary }]} numberOfLines={1}>
            ⚔ {e.territory_challenge.zone_ids.length} zones in play{e.territory_challenge.reward_xp ? ` · +${e.territory_challenge.reward_xp} XP` : ''}
          </Text>
        )}
      </View>
      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        <Text style={styles.count}>{e.participants_count}</Text>
        <Text style={styles.meta}>going</Text>
        {e.my_rsvp === 'going' && <Icon name="check-circle" size={16} color={colors.primary} />}
      </View>
    </PressScale>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 12 },
  icon: { width: 46, height: 46, borderRadius: 14, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cardHi },
  type: { fontFamily: fonts.label, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' },
  title: { color: colors.text, fontFamily: fonts.bold, fontSize: 15 },
  meta: { color: colors.dim, fontFamily: fonts.mono, fontSize: 11, marginTop: 2 },
  count: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 18 },
});
