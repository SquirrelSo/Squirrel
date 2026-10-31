import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Avatar } from '@/components/Avatar';
import { IconButton, LevelBadge, ProgressBar, tap } from '@/components/ui';
import { useApp, XP_PER_LEVEL } from '@/state/AppState';
import { useUnread } from '@/state/socialStore';
import { colors, fonts } from '@/theme';

/**
 * Home/tab top bar: your avatar + level/XP (only once a server has reported it), theme (sun/moon),
 * notifications. No coins: there's no currency on any backend.
 */
export function TopBar() {
  const { me, level, levelXp } = useApp();
  const unread = useUnread();
  return (
    <View style={styles.row}>
      <Pressable onPress={() => { tap(); router.push('/profile'); }} style={styles.me} accessibilityLabel={level != null ? `Your profile, level ${level}` : 'Your profile'}>
        <Avatar user={me} size={42} link={false} />
        {level != null && levelXp != null && (
          <View style={{ marginLeft: 8, width: 86 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <LevelBadge level={level} size="sm" />
              <Text style={styles.lv}>LV {level}</Text>
            </View>
            <ProgressBar progress={levelXp / XP_PER_LEVEL} color={colors.primary} color2={colors.violet} height={4} style={{ marginTop: 5 }} />
          </View>
        )}
      </Pressable>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <IconButton icon="bell-outline" badge={unread ?? undefined} size={20} onPress={() => router.push('/notifications')} label="Notifications" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  me: { flexDirection: 'row', alignItems: 'center' },
  lv: { color: colors.text, fontFamily: fonts.display, fontSize: 15, letterSpacing: 0.5 },
});
