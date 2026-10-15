/**
 * People who joined with my code (GET /v1/ambassador/referrals), newest first, paged with the
 * server's cursor. Public name and avatar only, plus how far each one got (verified, active, rewarded).
 */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ambassadorApi, type AmbassadorReferral, type AmbassadorReferralPage } from '@/api/ambassador';
import { PersonAvatar } from '@/components/campus/PersonAvatar';
import { EmptyNote, ErrorState, LoadingRows } from '@/components/campus/States';
import { shortTime } from '@/components/campus/territoryUi';
import { Button, Card, Icon } from '@/components/ui';
import { useCampus } from '@/hooks/useCampus';
import { colors, fonts } from '@/theme';

export function AmbassadorReferrals() {
  const r = useCampus<AmbassadorReferralPage>('ambassador:referrals', () => ambassadorApi.referrals());
  // Pages past the first, and where the next one starts (null: no more).
  const [older, setOlder] = useState<{ items: AmbassadorReferral[]; cursor: string | null } | null>(null);
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle');
  const cursor = older ? older.cursor : r.data?.next_cursor ?? null;
  const loadMore = async () => {
    if (!cursor || more === 'loading') return;
    setMore('loading');
    try {
      const page = await ambassadorApi.referrals(cursor);
      setOlder((o) => ({ items: [...(o?.items ?? []), ...page.items], cursor: page.next_cursor }));
      setMore('idle');
    } catch {
      setMore('error');
    }
  };

  if (r.error && !r.data) return <ErrorState cause={r.cause} onRetry={r.reload} compact feature="Your referrals" />;
  if (!r.data) return <LoadingRows rows={3} height={60} />;
  const seen = new Set(r.data.items.map((x) => x.user.id));
  const rows = [...r.data.items, ...(older?.items ?? []).filter((x) => !seen.has(x.user.id))];
  if (!rows.length) return <EmptyNote icon="account-multiple-plus-outline" title="Nobody yet" body="Share your code: people who join with it show up here." />;
  return (
    <View style={{ gap: 8 }}>
      {rows.map((x) => (
        <Card key={x.user.id} style={styles.row}>
          <PersonAvatar person={{ user_id: x.user.id, display_name: x.user.display_name, avatar_url: x.user.avatar_url }} size={40} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.name} numberOfLines={1}>{x.user.display_name}</Text>
            <Text style={styles.meta}>Joined {shortTime(x.signup_at)}</Text>
          </View>
          <Step on={x.verified} icon="email-check-outline" label="Verified" />
          <Step on={x.activated} icon="run-fast" label="Active" />
          <Step on={x.rewarded} icon="gift-outline" label="Rewarded" />
        </Card>
      ))}
      {cursor && (
        <Button
          label={more === 'loading' ? 'Loading…' : more === 'error' ? 'Couldn’t load — try again' : 'Show more'}
          variant="secondary"
          size="sm"
          iconLeft={more === 'error' ? 'refresh' : 'chevron-down'}
          disabled={more === 'loading'}
          onPress={loadMore}
          style={{ alignSelf: 'center', marginTop: 4 }}
        />
      )}
    </View>
  );
}

function Step({ on, icon, label }: { on: boolean; icon: React.ComponentProps<typeof Icon>['name']; label: string }) {
  return (
    <View accessibilityLabel={`${label}: ${on ? 'yes' : 'not yet'}`}>
      <Icon name={icon} size={18} color={on ? colors.primary : colors.mute} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  name: { color: colors.text, fontFamily: fonts.semibold, fontSize: 15 },
  meta: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12 },
});
