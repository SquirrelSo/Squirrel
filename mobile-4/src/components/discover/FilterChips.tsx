import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { Icon, tap } from '@/components/ui';
import { colors, fonts, radius } from '@/theme';

/** One row of single-choice filter chips (the Map's chip look). `null` is the "any" choice. */
export function FilterChips<T extends string>({ items, value, onChange, labels, icons, label }: { items: readonly (T | null)[]; value: T | null; onChange: (v: T | null) => void; labels: Record<string, string>; icons?: Partial<Record<string, React.ComponentProps<typeof Icon>['name']>>; label: string }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={styles.row} accessibilityRole="tablist" accessibilityLabel={label}>
      {items.map((i) => {
        const on = i === value;
        const k = i ?? 'any';
        const ic = icons?.[k];
        return (
          <Pressable key={k} onPress={() => { tap('select'); onChange(i); }} style={[styles.chip, on && styles.chipOn]} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={labels[k] ?? k}>
            {ic && <Icon name={ic} size={14} color={on ? colors.onPrimary : colors.sub} />}
            <Text style={[styles.chipText, on && { color: colors.onPrimary }]}>{labels[k] ?? k}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { gap: 6, alignItems: 'center', paddingVertical: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 32, paddingHorizontal: 12, borderRadius: radius.pill, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.sub, fontFamily: fonts.labelBold, fontSize: 13, letterSpacing: 0.8, textTransform: 'uppercase' },
});
