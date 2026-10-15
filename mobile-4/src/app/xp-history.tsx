/**
 * XP HISTORY — every XP line the Run Module counted for you, newest first (GET /v1/xp/history).
 * "Load more" pages back with the server's cursor. Cap cuts are their own negative lines; a
 * reversed award stays listed, struck through, and counts 0. Opened from Progress → XP history.
 */
import { useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { XpHistoryItem } from '@/api/featureContracts';
import { PROGRESS_READS_CONFIGURED, progressReadsLive } from '@/api/progress';
import { useRemote } from '@/api/useRemote';
import { xpApi } from '@/api/xp';
import { useAuth } from '@/auth/AuthProvider';
import { EmptyNote, ErrorState, LoadingRows, NotConnected } from '@/components/campus/States';
import { shortTime } from '@/components/campus/territoryUi';
import { Button, Header, Screen } from '@/components/ui';
import { useRefreshOnFocus } from '@/hooks/useCampus';
import { amountText, mergeHistory, reasonText, sourceLabel } from '@/logic/xpHistory';
import { colors, fonts, radius } from '@/theme';

export default function XpHistory() {
  const { mode } = useAuth();
  const live = progressReadsLive(mode);
  const r = useRemote(live ? 'xp:history' : null, () => xpApi.history());
  // Past the first page: every row loaded so far, and where the next page starts (null: no more).
  const [older, setOlder] = useState<{ kept: XpHistoryItem[]; cursor: string | null } | null>(null);
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle');
  const cursor = older ? older.cursor : r.data?.next_cursor ?? null;
  const loadMore = async () => {
    if (!cursor || more === 'loading' || !r.data) return;
    setMore('loading');
    try {
      const page = await xpApi.history(cursor);
      setOlder((o) => ({ kept: mergeHistory(o?.kept ?? [], page.items), cursor: page.next_cursor }));
      setMore('idle');
    } catch {
      setMore('error');
    }
  };
  useRefreshOnFocus(r.reload);
  const items = r.data ? mergeHistory(r.data.items, older?.kept ?? []) : [];

  return (
    <Screen tabBar={false} scroll={false}>
      <Header back title="XP history" />
      <FlatList
        data={items}
        keyExtractor={(x) => x.id}
        contentContainerStyle={{ gap: 8, paddingTop: 10, paddingBottom: 40 }}
        renderItem={({ item }) => <Line x={item} />}
        ListFooterComponent={
          items.length && cursor ? (
            <Button
              label={more === 'loading' ? 'Loading…' : more === 'error' ? 'Couldn’t load — try again' : 'Load more'}
              variant="secondary"
              size="sm"
              iconLeft={more === 'error' ? 'refresh' : 'chevron-down'}
              disabled={more === 'loading'}
              onPress={loadMore}
              style={{ marginTop: 6, alignSelf: 'center' }}
            />
          ) : null
        }
        ListEmptyComponent={
          !live ? (
            <NotConnected name="XP history" reason={PROGRESS_READS_CONFIGURED ? 'signed_out' : 'not_configured'} />
          ) : r.error ? (
            <ErrorState cause={r.cause} onRetry={r.reload} feature="XP history" />
          ) : r.loading ? (
            <LoadingRows rows={6} height={58} />
          ) : (
            <EmptyNote icon="star-four-points-outline" title="No XP yet" body="Runs, workouts, meetups and challenges all earn XP. It shows up here." action="Start a run" onAction={() => router.push('/run')} />
          )
        }
      />
    </Screen>
  );
}

/** One XP line: what it was for, where it came from, when, and the amount the server counted. */
function Line({ x }: { x: XpHistoryItem }) {
  const reason = reasonText(x.reason);
  const source = sourceLabel(x.source);
  const when = shortTime(x.created_at);
  return (
    <View style={[styles.row, x.reversed && styles.reversedRow]} accessibilityLabel={`${reason}, ${source}, ${amountText(x.amount)}${x.reversed ? ', reversed' : ''}, ${when}`}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.reason, x.reversed && styles.struck]} numberOfLines={2}>{reason}</Text>
        <Text style={styles.meta}>
          {source} · {when}
        </Text>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[styles.amount, x.amount < 0 && { color: colors.coral }, x.reversed && styles.struck]}>{amountText(x.amount)}</Text>
        {x.reversed && <Text style={styles.reversed}>Reversed</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, paddingVertical: 10, paddingHorizontal: 12 },
  reversedRow: { opacity: 0.7 },
  reason: { color: colors.text, fontFamily: fonts.bold, fontSize: 14 },
  meta: { color: colors.dim, fontFamily: fonts.mono, fontSize: 10, marginTop: 2 },
  amount: { color: colors.gold, fontFamily: fonts.labelBold, fontSize: 16 },
  struck: { textDecorationLine: 'line-through', color: colors.dim },
  reversed: { color: colors.coral, fontFamily: fonts.label, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' },
});
