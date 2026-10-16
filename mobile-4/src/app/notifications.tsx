import { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, type Href } from 'expo-router';
import type { AppNotification } from '@/api/campus';
import { getNotifications, markAllNotificationsRead, markNotificationRead } from '@/api/campus/poke';
import { PersonAvatar } from '@/components/campus/PersonAvatar';
import { EmptyNote, ErrorState, LoadingRows } from '@/components/campus/States';
import { shortTime } from '@/components/campus/territoryUi';
import { useLocks } from '@/components/Locked';
import { PokeButton } from '@/components/social/PokeButton';
import { useCampus, useRealtime, useRefreshOnFocus } from '@/hooks/useCampus';
import { earlierRows, keepOlder } from '@/logic/notificationPages';
import { useApp } from '@/state/AppState';
import { setUnread } from '@/state/socialStore';
import { Button, Header, Icon, IconButton, Screen } from '@/components/ui';
import { alpha, colors, fonts, radius } from '@/theme';

type IconName = React.ComponentProps<typeof Icon>['name'];
type Kind = { icon: IconName; color: string; label?: string };

// Every type the Social service (via api/campus/socialAdapter.ts) or the campus backend sends.
const KIND: Record<string, Kind> = {
  poke: { icon: 'hand-wave', color: colors.secondary },
  friendship: { icon: 'account-heart', color: colors.primary },
  territory: { icon: 'shield-alert', color: colors.gold, label: 'Territory alert' },
  invite: { icon: 'sword-cross', color: colors.secondary, label: 'Challenge' },
  event: { icon: 'calendar-star', color: colors.violet },
  badge: { icon: 'medal-outline', color: colors.gold },
  checkin: { icon: 'map-marker-check-outline', color: colors.green },
  crew: { icon: 'account-group', color: colors.blue },
  comment: { icon: 'comment-text-outline', color: colors.blue },
  like: { icon: 'heart', color: colors.pink },
  study_break: { icon: 'coffee-outline', color: colors.secondary },
  meetup_rating: { icon: 'star-outline', color: colors.primary },
  media: { icon: 'image-check-outline', color: colors.violet },
  ambassador: { icon: 'star-four-points-outline', color: colors.violet },
  shared_zone: { icon: 'map-marker-radius', color: colors.primary },
  date_suggestion: { icon: 'map-marker-account-outline', color: colors.secondary },
  // Routed by kind in the adapter (logic/notificationPrefs.ts kindRoute).
  'xp.level_up': { icon: 'arrow-up-bold-circle-outline', color: colors.gold, label: 'Level up' },
  'shared_workout.invited': { icon: 'dumbbell', color: colors.secondary, label: 'Workout invite' },
  'shared_workout.finished': { icon: 'trophy-outline', color: colors.primary, label: 'Workout results' },
  'bubble.activity': { icon: 'account-multiple-outline', color: colors.blue, label: 'Your bubble' },
  'ambassador.task': { icon: 'clipboard-check-outline', color: colors.violet, label: 'Ambassador task' },
  'ambassador.reward': { icon: 'star-four-points', color: colors.gold, label: 'Ambassador reward' },
  'ambassador.suspended': { icon: 'pause-circle-outline', color: colors.coral, label: 'Ambassador role paused' },
  'system.announcement': { icon: 'bullhorn-outline', color: colors.primary, label: 'Announcement' },
};
const FALLBACK: Kind = { icon: 'bell-outline', color: colors.dim };

/** Territory FOMO alerts arrive as one type; the wording tells lost / captured / expiring apart. */
function territoryKind(text: string): Kind {
  if (/\b(lost|stolen)\b|\b(captured|took|taken|stole|claimed)\s+(your|from you)/i.test(text)) return { icon: 'shield-off-outline', color: colors.coral, label: 'Zone lost' };
  if (/\b(expir|fading|decay|about to)/i.test(text)) return { icon: 'timer-sand', color: colors.orange, label: 'Zone expiring' };
  if (/\b(captur|claimed|conquer)/i.test(text)) return { icon: 'flag-checkered', color: colors.primary, label: 'Zone captured' };
  return KIND.territory;
}

const kindOf = (n: AppNotification): Kind => (n.type === 'territory' ? territoryKind(n.text) : KIND[n.type] ?? FALLBACK);

/**
 * Notifications: pokes (with POKE BACK), friendships, territory alerts and campus activity from the
 * backend. Without a backend the list says "Not live yet" — there are no sample notifications.
 * The newest page is grouped (people first); "Show older" pages back through the rest with the
 * server’s cursor, in time order under "Earlier". A tap marks one row read; "Mark all read" the rest.
 * The gear opens notification settings.
 */
export default function Notifications() {
  return <CampusNotifications />;
}

function CampusNotifications() {
  const { toast } = useApp();
  const r = useCampus<{ items: AppNotification[]; unread: number; next_cursor: string | null }>('notifications', () => getNotifications());
  const [markingAll, setMarkingAll] = useState(false);
  // Past the first page: every row loaded so far, and where the next page starts (null: no more).
  const [older, setOlder] = useState<{ kept: AppNotification[]; cursor: string | null } | null>(null);
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle');
  const cursor = older ? older.cursor : r.data?.next_cursor ?? null;
  const loadOlder = async () => {
    if (!cursor || more === 'loading' || !r.data) return;
    const first = r.data.items;
    setMore('loading');
    try {
      const page = await getNotifications(cursor);
      setOlder((o) => ({ kept: keepOlder(o?.kept ?? [], first, page.items), cursor: page.next_cursor }));
      setMore('idle');
    } catch {
      setMore('error');
    }
  };
  useRefreshOnFocus(r.reload, 20_000);
  useRealtime((m) => {
    if (m.type === 'notification.created' && r.data) r.mutate({ ...r.data, items: [m.data, ...r.data.items.filter((n) => n.id !== m.data.id)], unread: r.data.unread + 1 });
  });
  const earlier = older && r.data ? earlierRows(older.kept, r.data.items) : [];
  // The badge follows the server's count; rows are read one at a time (a tap) or all at once.
  const serverUnread = r.data?.unread;
  useEffect(() => {
    if (serverUnread != null) setUnread(serverUnread);
  }, [serverUnread]);

  /** A tap on an unread row: shown read straight away; the server's count comes back with it. */
  const readOne = (n: AppNotification) => {
    if (n.read) return;
    const asRead = (list: AppNotification[]) => list.map((x) => (x.id === n.id ? { ...x, read: true } : x));
    if (r.data) r.mutate({ ...r.data, items: asRead(r.data.items), unread: Math.max(0, r.data.unread - 1) });
    setOlder((o) => o && { ...o, kept: asRead(o.kept) });
    // A failure leaves it unread on the server; the next refresh shows it unread again.
    markNotificationRead(n.id)
      .then((x) => setUnread(x.unread))
      .catch(() => undefined);
  };

  const markAll = async () => {
    if (markingAll) return;
    setMarkingAll(true);
    try {
      const x = await markAllNotificationsRead();
      setUnread(x.unread);
      if (r.data) r.mutate({ ...r.data, items: r.data.items.map((n) => ({ ...n, read: true })), unread: x.unread });
      setOlder((o) => o && { ...o, kept: o.kept.map((n) => ({ ...n, read: true })) });
    } catch {
      toast('Couldn’t mark as read — try again', 'alert-circle-outline', colors.coral);
    } finally {
      setMarkingAll(false);
    }
  };

  const items = r.data?.items ?? [];
  const hasUnread = items.some((n) => !n.read) || earlier.some((n) => !n.read) || (r.data?.unread ?? 0) > 0;
  // People first (pokes, friendships, shared ground, Squirrel Dates); everything campus after.
  const PEOPLE = new Set(['poke', 'friendship', 'shared_zone', 'date_suggestion']);
  const pokes = items.filter((n) => PEOPLE.has(n.type));
  const rest = items.filter((n) => !PEOPLE.has(n.type));
  return (
    <Screen tabBar={false} scroll={false}>
      <Header
        back
        title="Notifications"
        right={
          <>
            {hasUnread && <Button label="Mark all read" size="sm" variant="ghost" iconLeft="check-all" onPress={markAll} disabled={markingAll} />}
            <IconButton icon="cog-outline" onPress={() => router.push('/notification-settings')} label="Notification settings" />
          </>
        }
      />
      <FlatList
        data={[...pokes, ...rest, ...earlier]}
        keyExtractor={(n) => n.id}
        contentContainerStyle={{ gap: 10, paddingTop: 10, paddingBottom: 40 }}
        ListHeaderComponent={pokes.length ? <Text style={styles.section}>People</Text> : null}
        renderItem={({ item, index }) => (
          <View>
            {index === pokes.length && rest.length > 0 && <Text style={[styles.section, { marginTop: 8, marginBottom: 10 }]}>Campus</Text>}
            {index === items.length && <Text style={[styles.section, { marginTop: 8, marginBottom: 10 }]}>Earlier</Text>}
            <NotificationCard n={item} onOpen={() => readOne(item)} />
          </View>
        )}
        ListFooterComponent={
          items.length && cursor ? (
            <Button
              label={more === 'loading' ? 'Loading…' : more === 'error' ? 'Couldn’t load — try again' : 'Show older'}
              variant="secondary"
              size="sm"
              iconLeft={more === 'error' ? 'refresh' : 'chevron-down'}
              disabled={more === 'loading'}
              onPress={loadOlder}
              style={{ marginTop: 6, alignSelf: 'center' }}
            />
          ) : null
        }
        ListEmptyComponent={
          r.signedOut ? (
            <EmptyNote icon="account-lock-outline" title="Sign in to see notifications" action="Sign in" onAction={() => router.push('/sign-in')} />
          ) : r.error ? (
            <ErrorState cause={r.cause} onRetry={r.reload} feature="Notifications" />
          ) : r.loading ? (
            <LoadingRows rows={4} height={68} />
          ) : (
            <EmptyNote icon="bell-sleep-outline" title="All quiet" body="Pokes, new friends and territory alerts land here." action="Open the map" onAction={() => router.push('/explore')} />
          )
        }
      />
    </Screen>
  );
}

/** One row. Taps mark it read and open `data.route` when the backend sent one, else route by type. */
function NotificationCard({ n, onOpen }: { n: AppNotification; onOpen: () => void }) {
  const locks = useLocks();
  const ui = kindOf(n);
  const territory = n.type === 'territory';
  const open = () => {
    onOpen();
    const d = n.data ?? {};
    if (typeof d.route === 'string' && d.route.startsWith('/') && !d.route.startsWith('//')) router.push(d.route as Href);
    else if (n.type === 'shared_zone' && d.user_id) router.push({ pathname: '/shared/[id]', params: { id: d.user_id } });
    else if (n.type === 'meetup_rating' && d.meetup_id) router.push({ pathname: '/meetup/[id]', params: { id: d.meetup_id } });
    else if (n.type === 'ambassador') router.push('/ambassador');
    else if (n.type === 'date_suggestion') router.push('/social');
    else if (territory && d.zone_id) router.push({ pathname: '/zone/[id]', params: { id: d.zone_id } });
    else if (d.user_id) router.push({ pathname: '/user/[id]', params: { id: d.user_id } });
    else if (d.zone_id) router.push({ pathname: '/zone/[id]', params: { id: d.zone_id } });
    else if (d.invite_id) router.push('/invites');
    else if (d.event_id) locks.guard('events', () => router.push({ pathname: '/event/[id]', params: { id: d.event_id! } }))();
  };
  return (
    <View style={[styles.row, !n.read && styles.unread, territory && { borderColor: alpha(ui.color, n.read ? 0.4 : 0.8), backgroundColor: alpha(ui.color, 0.08), borderWidth: 1.5 }]}>
      <Pressable onPress={open} style={styles.main} accessibilityRole="button" accessibilityLabel={`${ui.label ? `${ui.label}. ` : ''}${n.text}, ${shortTime(n.created_at)}${n.read ? '' : ', unread'}`}>
        {n.actor && !territory ? (
          <View>
            <PersonAvatar person={n.actor} size={44} link={false} />
            <View style={[styles.kind, { backgroundColor: ui.color }]}>
              <Icon name={ui.icon} size={11} color={colors.onPrimary} />
            </View>
          </View>
        ) : (
          <View style={[styles.icon, { backgroundColor: alpha(ui.color, 0.16), borderColor: alpha(ui.color, 0.5) }]}>
            <Icon name={ui.icon} size={22} color={ui.color} />
          </View>
        )}
        <View style={{ flex: 1 }}>
          {!!ui.label && <Text style={[styles.label, { color: ui.color }]}>{ui.label}</Text>}
          <Text style={[styles.text, territory && styles.textStrong]}>{n.text}</Text>
          <Text style={styles.time}>{shortTime(n.created_at)}</Text>
        </View>
        {!n.read && <View style={[styles.dot, territory && { backgroundColor: ui.color }]} accessibilityElementsHidden />}
      </Pressable>
      {n.type === 'poke' && n.actor && <PokeButton user={n.actor} size="sm" />}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { color: colors.dim, fontFamily: fonts.label, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 12 },
  unread: { borderColor: alpha(colors.primary, 0.35) },
  main: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  kind: { position: 'absolute', right: -3, bottom: -3, width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.card },
  label: { fontFamily: fonts.label, fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 2 },
  text: { color: colors.sub, fontFamily: fonts.medium, fontSize: 14, lineHeight: 19 },
  textStrong: { color: colors.text, fontFamily: fonts.semibold },
  time: { color: colors.dim, fontFamily: fonts.regular, fontSize: 11, marginTop: 2 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary },
});
