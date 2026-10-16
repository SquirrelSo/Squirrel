/**
 * One post from the Social service (feed + post detail). Everything shown comes from the server's
 * Post; like/save are optimistic and reconciled with the server's answer (reverted on failure).
 */
import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { postsApi, type Activity, type Post, type PostAuthor } from '@/api/social';
import { StickerArt } from '@/art/Sticker';
import { SceneImage } from '@/components/cards';
import { PersonAvatar } from '@/components/campus/PersonAvatar';
import { shortTime } from '@/components/campus/territoryUi';
import { Icon, tap } from '@/components/ui';
import { useApp } from '@/state/AppState';
import type { SceneKind, StickerKind } from '@/types';
import { alpha, colors, fonts, radius } from '@/theme';

const SCENE_KINDS: readonly SceneKind[] = ['city-sunset', 'city-night', 'city-dawn', 'run', 'yoga', 'cafe', 'brunch', 'crew', 'hiit', 'cycling', 'lake', 'rooftop', 'stadium'];
const STICKER_KINDS: readonly StickerKind[] = ['no-days-off', 'squirrel-flex', 'neon-heart', 'crown', 'fire', 'good-vibes', 'one-more-km', 'hydrate'];

export const asPerson = (u: PostAuthor) => ({ user_id: u.id, display_name: u.display_name, avatar_url: u.avatar_url, hostel: null });
const sceneOf = (s: string | undefined): SceneKind => (SCENE_KINDS as readonly string[]).includes(s ?? '') ? (s as SceneKind) : 'city-sunset';
const stickerOf = (s: string | null): StickerKind | null => (s && (STICKER_KINDS as readonly string[]).includes(s) ? (s as StickerKind) : null);

/** "5.2 km run · 28 min · 5:23/km" from the server's activity — only the fields it actually has. */
export function activityLine(a: Activity): string {
  const head = a.distance_km != null ? `${+a.distance_km.toFixed(2)} km ${a.type}` : a.name || a.type;
  const parts = [head];
  if (a.duration_minutes != null) parts.push(`${Math.round(a.duration_minutes)} min`);
  if (a.pace) parts.push(`${a.pace}/km`);
  return parts.join(' · ');
}

export function PostCard({ post, open = true, onChange }: { post: Post; open?: boolean; onChange?: (p: Post) => void }) {
  const { toast } = useApp();
  const [liked, setLiked] = useState(post.liked_by_me);
  const [likes, setLikes] = useState(post.likes_count);
  const [saved, setSaved] = useState(post.saved_by_me);
  const [busy, setBusy] = useState<{ like?: boolean; save?: boolean }>({});
  const sticker = stickerOf(post.sticker);

  const goPost = () => {
    if (!open) return;
    tap();
    router.push({ pathname: '/post/[id]', params: { id: post.id } });
  };

  const toggleLike = async () => {
    if (busy.like) return;
    tap();
    const on = !liked;
    const prev = { liked, likes };
    setLiked(on);
    setLikes((n) => Math.max(0, n + (on ? 1 : -1)));
    setBusy((b) => ({ ...b, like: true }));
    try {
      const r = await (on ? postsApi.like(post.id) : postsApi.unlike(post.id));
      setLiked(r.liked);
      setLikes(r.likes_count);
      onChange?.({ ...post, liked_by_me: r.liked, likes_count: r.likes_count, saved_by_me: saved });
    } catch {
      setLiked(prev.liked);
      setLikes(prev.likes);
      toast(on ? 'Couldn’t like that post' : 'Couldn’t remove your like', 'alert-circle-outline', colors.coral);
    } finally {
      setBusy((b) => ({ ...b, like: false }));
    }
  };

  const toggleSave = async () => {
    if (busy.save) return;
    tap();
    const on = !saved;
    setSaved(on);
    setBusy((b) => ({ ...b, save: true }));
    try {
      const r = await (on ? postsApi.save(post.id) : postsApi.unsave(post.id));
      setSaved(r.saved);
      onChange?.({ ...post, liked_by_me: liked, likes_count: likes, saved_by_me: r.saved });
      toast(r.saved ? 'Saved' : 'Removed from saved', r.saved ? 'bookmark' : 'bookmark-outline');
    } catch {
      setSaved(!on);
      toast('Couldn’t update saved', 'alert-circle-outline', colors.coral);
    } finally {
      setBusy((b) => ({ ...b, save: false }));
    }
  };

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <PersonAvatar person={asPerson(post.author)} size={38} />
        <Pressable style={{ flex: 1, marginLeft: 10 }} onPress={() => router.push({ pathname: '/user/[id]', params: { id: post.author.id } })} accessibilityRole="button" accessibilityLabel={`Open ${post.author.display_name}'s profile`}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Text style={styles.name} numberOfLines={1}>{post.author.display_name}</Text>
            {post.author.verified && <Icon name="check-decagram" size={14} color={colors.blue} />}
          </View>
          <Text style={styles.meta} numberOfLines={1}>
            {shortTime(post.created_at)}
            {post.crew_name ? ` · ${post.crew_name}` : ''}
            {post.area ? ` · ${post.area}` : ''}
          </Text>
        </Pressable>
      </View>

      <Pressable onPress={goPost} disabled={!open} accessibilityRole={open ? 'button' : undefined} accessibilityLabel={open ? 'Open post' : undefined}>
        <SceneImage kind={sceneOf(post.backdrop?.scene)} seed={post.backdrop?.seed ?? 1} aspect={1.2} scrim={false}>
          {post.media_url ? <Image source={{ uri: post.media_url }} style={StyleSheet.absoluteFill} resizeMode="cover" accessibilityLabel={`Photo by ${post.author.display_name}`} /> : null}
          {post.activity && (
            <View style={styles.actChip}>
              <Icon name={post.activity.verified ? 'check-circle' : 'run'} size={13} color={colors.onImage} />
              <Text style={styles.actText}>{activityLine(post.activity)}</Text>
            </View>
          )}
          {sticker && <StickerArt kind={sticker} size={80} style={styles.sticker} />}
        </SceneImage>
      </Pressable>

      {post.caption ? <Text style={styles.caption}>{post.caption}</Text> : null}

      <View style={styles.actions}>
        <Pressable onPress={toggleLike} style={styles.action} hitSlop={8} accessibilityRole="button" accessibilityState={{ selected: liked }} accessibilityLabel={liked ? `Unlike, ${likes} likes` : `Like, ${likes} likes`}>
          <Icon name={liked ? 'heart' : 'heart-outline'} size={22} color={liked ? colors.coral : colors.sub} />
          <Text style={styles.count}>{likes}</Text>
        </Pressable>
        <Pressable onPress={goPost} disabled={!open} style={styles.action} hitSlop={8} accessibilityRole="button" accessibilityLabel={`${post.comments_count} comments`}>
          <Icon name="comment-outline" size={21} color={colors.sub} />
          <Text style={styles.count}>{post.comments_count}</Text>
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable onPress={toggleSave} style={styles.action} hitSlop={8} accessibilityRole="button" accessibilityState={{ selected: saved }} accessibilityLabel={saved ? 'Unsave post' : 'Save post'}>
          <Icon name={saved ? 'bookmark' : 'bookmark-outline'} size={22} color={saved ? colors.primary : colors.sub} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 12, marginBottom: 14 },
  head: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  name: { color: colors.text, fontFamily: fonts.semibold, fontSize: 15, flexShrink: 1 },
  meta: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, marginTop: 1 },
  caption: { color: colors.text, fontFamily: fonts.regular, fontSize: 15, lineHeight: 21, marginTop: 10 },
  actChip: { position: 'absolute', left: 10, bottom: 10, flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(10,10,10,0.8)', borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 6 },
  actText: { color: colors.onImage, fontFamily: fonts.semibold, fontSize: 12 },
  sticker: { position: 'absolute', right: 12, top: 12, transform: [{ rotate: '8deg' }] },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 18, marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: alpha(colors.line, 0.8) },
  action: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  count: { color: colors.sub, fontFamily: fonts.semibold, fontSize: 13 },
});
