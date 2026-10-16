import React from 'react';
import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { router } from 'expo-router';
import { Portrait } from '@/art/Character';
import { colors, fonts } from '@/theme';
import type { AvatarLook } from '@/types';
import { tap } from '@/components/ui';

/** Someone with an illustrated look: you (your Avatar setting), or anyone the backend gives one. */
export type AvatarPerson = { id: string; name?: string | null; look: AvatarLook };
const ME_ID = 'me';

/** Portrait with optional level chip / online dot; tapping opens the user's profile. */
export function Avatar({
  user,
  look,
  size = 44,
  ring = colors.primary,
  level,
  online,
  link = true,
  style,
}: {
  user?: AvatarPerson;
  look?: AvatarLook;
  size?: number;
  ring?: string | false;
  level?: number;
  online?: boolean;
  link?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const l = look ?? user?.look;
  if (!l) return null;
  const body = (
    <View style={[{ width: size, height: size }, style]}>
      <Portrait look={l} size={size} ring={ring} />
      {level != null && (
        <View style={{ position: 'absolute', bottom: -4, alignSelf: 'center', backgroundColor: colors.purple, borderRadius: 8, paddingHorizontal: 5, borderWidth: 1.5, borderColor: colors.bg }}>
          <Text style={{ color: colors.onPrimary, fontFamily: fonts.bold, fontSize: Math.max(9, size * 0.16) }}>LV {level}</Text>
        </View>
      )}
      {online && <View style={{ position: 'absolute', right: 1, bottom: 1, width: size * 0.24, height: size * 0.24, borderRadius: size, backgroundColor: colors.green, borderWidth: 2, borderColor: colors.bg }} />}
    </View>
  );
  if (!link || !user) return body;
  return (
    <Pressable
      accessibilityLabel={`Open ${user.name ?? 'their'} profile`}
      onPress={() => {
        tap();
        router.push(user.id === ME_ID ? '/profile' : { pathname: '/user/[id]', params: { id: user.id } });
      }}>
      {body}
    </Pressable>
  );
}

/** Overlapping avatar stack with "+N". */
export function AvatarStack({ users, extra, size = 26 }: { users: AvatarPerson[]; extra?: number; size?: number }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {users.slice(0, 4).map((u, i) => (
        <View key={u.id} style={{ marginLeft: i ? -size * 0.35 : 0, borderRadius: size, borderWidth: 2, borderColor: colors.bg }}>
          <Portrait look={u.look} size={size} ring={false} />
        </View>
      ))}
      {!!extra && <Text style={{ color: colors.text, fontFamily: fonts.bold, fontSize: 12, marginLeft: 6 }}>+{extra}</Text>}
    </View>
  );
}
