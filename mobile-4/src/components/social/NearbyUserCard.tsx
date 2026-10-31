/**
 * NearbyUserCard — avatar, name, level, XP, coarse proximity (only when the backend sends it),
 * friendship state and the Poke action. Used on the Map, in search, Social, Active Now and
 * notifications.
 */
import { useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { PersonLite, Proximity, RelationshipState } from '@/api/campus/types';
import { PersonAvatar } from '@/components/campus/PersonAvatar';
import { PROXIMITY_TEXT } from '@/components/campus/Social';
import { PokeButton, RELATION_TEXT } from '@/components/social/PokeButton';
import { Icon, NATIVE } from '@/components/ui';
import { useRelationship } from '@/state/socialStore';
import { colors, fonts, radius } from '@/theme';

export type NearbyPerson = PersonLite & { level?: number; xp?: number; proximity?: Proximity | null; relationship?: RelationshipState; activity?: string | null };

export function NearbyUserCard({ person, variant = 'row', onOpen }: { person: NearbyPerson; variant?: 'row' | 'card'; onOpen?: () => void }) {
  const rel = useRelationship(person.user_id, person.relationship);
  const [wiggle] = useState(() => new Animated.Value(0));
  const react = () => {
    wiggle.setValue(0);
    Animated.sequence([
      Animated.timing(wiggle, { toValue: 1, duration: 90, useNativeDriver: NATIVE }),
      Animated.timing(wiggle, { toValue: -1, duration: 90, useNativeDriver: NATIVE }),
      Animated.timing(wiggle, { toValue: 0, duration: 90, useNativeDriver: NATIVE }),
    ]).start();
  };
  const open = onOpen ?? (() => router.push({ pathname: '/user/[id]', params: { id: person.user_id } }));
  const card = variant === 'card';
  const stateText = rel ? RELATION_TEXT[rel.state] : '';
  const meta = [person.level != null ? `Level ${person.level}` : null, person.xp != null ? `${person.xp.toLocaleString('en-IN')} XP` : null].filter(Boolean).join(' · ');

  return (
    <View style={[styles.wrap, card && styles.card]}>
      <Pressable onPress={open} style={[styles.who, card && { alignItems: 'flex-start' }]} accessibilityRole="button" accessibilityLabel={`Open ${person.display_name}'s profile`}>
        <Animated.View style={{ transform: [{ rotate: wiggle.interpolate({ inputRange: [-1, 1], outputRange: ['-12deg', '12deg'] }) }] }}>
          <PersonAvatar person={person} size={card ? 56 : 44} link={false} ring={rel?.state === 'friends' ? colors.primary : undefined} />
          {rel?.state === 'friends' && (
            <View style={styles.friendBadge}>
              <Icon name="account-heart" size={10} color={colors.onPrimary} />
            </View>
          )}
        </Animated.View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.name, card && { fontSize: 20 }]} numberOfLines={1}>{person.display_name}</Text>
          {!!meta && <Text style={styles.meta}>{meta}</Text>}
          <View style={styles.tags}>
            {!!person.proximity && (
              <View style={styles.tag}>
                <Icon name="map-marker-radius" size={11} color={colors.primary} />
                <Text style={styles.tagText}>{PROXIMITY_TEXT[person.proximity]}</Text>
              </View>
            )}
            {!!stateText && (
              <View style={[styles.tag, { borderColor: rel?.state === 'friends' ? colors.primary : rel?.state === 'poked_you' ? colors.secondary : colors.lineHi }]}>
                <Icon name={rel?.state === 'friends' ? 'account-heart' : 'hand-wave'} size={11} color={rel?.state === 'poked_you' ? colors.secondary : colors.sub} />
                <Text style={styles.tagText}>{stateText}</Text>
              </View>
            )}
          </View>
        </View>
      </Pressable>
      <PokeButton user={person} seed={person.relationship} size={card ? 'md' : 'sm'} onPoked={react} style={card ? { marginTop: 14 } : undefined} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 12 },
  card: { flexDirection: 'column', alignItems: 'stretch', padding: 16 },
  who: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  name: { color: colors.text, fontFamily: fonts.bold, fontSize: 15 },
  meta: { color: colors.gold, fontFamily: fonts.mono, fontSize: 11, marginTop: 2 },
  tags: { flexDirection: 'row', gap: 6, marginTop: 4, flexWrap: 'wrap' },
  tag: { flexDirection: 'row', alignItems: 'center', gap: 3, borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 1 },
  tagText: { color: colors.sub, fontFamily: fonts.label, fontSize: 10, letterSpacing: 0.6, textTransform: 'uppercase' },
  friendBadge: { position: 'absolute', right: -3, bottom: -3, width: 18, height: 18, borderRadius: 9, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.card },
});
