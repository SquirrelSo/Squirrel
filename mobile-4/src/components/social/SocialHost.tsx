/**
 * Root-level social host: routes realtime poke / friendship events into the social store,
 * keeps the unread badge in sync, and shows the FriendshipCelebration moment.
 */
import { useEffect, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CAMPUS_SOURCE } from '@/api/campus';
import { getNotifications } from '@/api/campus/poke';
import { Avatar } from '@/components/Avatar';
import { PersonAvatar } from '@/components/campus/PersonAvatar';
import { CaptureMomentHost } from '@/components/game/CaptureMoment';
import { Button, Display, Icon, NATIVE, tap } from '@/components/ui';
import { useCampusSession, useRealtime } from '@/hooks/useCampus';
import { applyRelationship, celebrate, dismissCelebration, setUnread, useCelebration, type Friend } from '@/state/socialStore';
import { useApp } from '@/state/AppState';
import { colors, fonts, MAX_WIDTH, radius } from '@/theme';

export function SocialHost() {
  const { toast } = useApp();
  const { signedIn } = useCampusSession();
  const enabled = CAMPUS_SOURCE !== 'off' && signedIn;

  // Unread badge: initial count from the backend, then realtime.
  useEffect(() => {
    if (!enabled) return;
    getNotifications()
      .then((r) => setUnread(r.unread))
      .catch(() => undefined);
  }, [enabled]);

  useRealtime((m) => {
    if (!enabled) return;
    if (m.type === 'relationship.updated') applyRelationship(m.data);
    else if (m.type === 'friendship.created') {
      applyRelationship(m.data.relationship);
      celebrate(m.data.friend);
    } else if (m.type === 'poke.received') {
      tap('impact');
      toast(`${m.data.from.display_name.split(' ')[0]} poked you 👋 · poke back from their card`, 'hand-wave', colors.secondary);
    } else if (m.type === 'notification.created') setUnread((n) => n + 1);
  });

  const friend = useCelebration();
  return (
    <>
      <CaptureMomentHost />
      {friend ? <FriendshipCelebration key={friend.user_id} friend={friend} /> : null}
    </>
  );
}

/** "YOU'RE FRIENDS" — short, game-like, dismissible. Shown only after backend confirmation. */
export function FriendshipCelebration({ friend }: { friend: Friend }) {
  const insets = useSafeAreaInsets();
  const { me } = useApp();
  const [v] = useState(() => new Animated.Value(0));
  const [bump] = useState(() => new Animated.Value(0));
  useEffect(() => {
    tap('success');
    Animated.parallel([
      Animated.spring(v, { toValue: 1, useNativeDriver: NATIVE, speed: 14, bounciness: 9 }),
      Animated.sequence([
        Animated.delay(220),
        Animated.timing(bump, { toValue: 1, duration: 260, easing: Easing.out(Easing.back(3)), useNativeDriver: NATIVE }),
      ]),
    ]).start();
  }, [v, bump]);
  const close = (then?: () => void) => {
    Animated.timing(v, { toValue: 0, duration: 160, useNativeDriver: NATIVE }).start(() => {
      dismissCelebration();
      then?.();
    });
  };
  const first = friend.display_name.split(' ')[0];
  const lean = (dir: 1 | -1) => ({ transform: [{ translateX: bump.interpolate({ inputRange: [0, 1], outputRange: [0, dir * 8] }) }, { rotate: bump.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${dir * 8}deg`] }) }] });

  return (
    <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
      <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: v }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => close()} accessibilityLabel="Close" />
      </Animated.View>
      <View style={[styles.center, { paddingTop: insets.top, paddingBottom: insets.bottom }]} pointerEvents="box-none">
        <Animated.View style={[styles.card, { opacity: v, transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] }) }] }]} accessibilityLiveRegion="assertive">
          <Text style={styles.emoji} accessibilityElementsHidden>🎉</Text>
          <Display size={34} style={{ textAlign: 'center' }}>You’re <Text style={{ color: colors.primary }}>friends</Text></Display>
          <Text style={styles.body}>You and {first} just connected.</Text>
          <View style={styles.pair}>
            <Animated.View style={lean(1)}>
              <Avatar user={me} size={60} ring={colors.primary} link={false} />
            </Animated.View>
            <Icon name="swap-horizontal" size={22} color={colors.primary} />
            <Animated.View style={lean(-1)}>
              <PersonAvatar person={friend} size={60} ring={colors.primary} link={false} />
            </Animated.View>
          </View>
          <Button label="View profile" size="md" iconLeft="account" onPress={() => close(() => router.push({ pathname: '/user/[id]', params: { id: friend.user_id } }))} style={{ alignSelf: 'stretch' }} />
          <Button label="Keep exploring" variant="ghost" size="sm" onPress={() => close()} style={{ alignSelf: 'stretch', marginTop: 8 }} />
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: colors.backdrop },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  card: { width: '100%', maxWidth: Math.min(360, MAX_WIDTH), alignItems: 'center', backgroundColor: colors.bg2, borderRadius: radius.xl, borderWidth: 1.5, borderColor: colors.primary, padding: 20 },
  emoji: { fontSize: 40, marginBottom: 4 },
  body: { color: colors.sub, fontFamily: fonts.medium, fontSize: 14, marginTop: 4, textAlign: 'center' },
  pair: { flexDirection: 'row', alignItems: 'center', gap: 14, marginVertical: 18 },
});
