import { useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SOCIAL_API_CONFIGURED } from '@/api/config';
import { commentsApi, postsApi, type Comment } from '@/api/social';
import { errorText } from '@/api/campus';
import { EmptyNote, ErrorState, LoadingRows, NotConnected, SignedOutState } from '@/components/campus/States';
import { PersonAvatar } from '@/components/campus/PersonAvatar';
import { shortTime } from '@/components/campus/territoryUi';
import { asPerson, PostCard } from '@/components/social/PostCard';
import { Button, Header, Icon, IconButton, Label, Screen, tap } from '@/components/ui';
import { invalidateCampus, useAction, useCampus } from '@/hooks/useCampus';
import { useApp } from '@/state/AppState';
import { colors, fonts, radius } from '@/theme';

const MAX_COMMENT = 300;

/** Confirm before a destructive action (Alert has no buttons on web). */
function confirm(title: string, body: string, ok: () => void) {
  if (Platform.OS === 'web') {
    if (globalThis.confirm?.(`${title}\n\n${body}`)) ok();
    return;
  }
  Alert.alert(title, body, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: ok },
  ]);
}

/** A single post from the Social service, with its comments and a comment composer. */
export default function PostScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!SOCIAL_API_CONFIGURED) {
    return (
      <Screen tabBar={false}>
        <Header back title="Post" />
        <NotConnected name="Posts" reason="not_configured" />
      </Screen>
    );
  }
  return <PostDetail id={id} />;
}

function PostDetail({ id }: { id: string }) {
  const { toast } = useApp();
  const post = useCampus(`social:post:${id}`, () => postsApi.get(id), { enabled: !!id });
  const comments = useCampus(`social:comments:${id}`, () => commentsApi.list(id), { enabled: !!id });
  const [draft, setDraft] = useState('');
  const send = useAction((body: string) => commentsApi.create(id, body));
  const [removing, setRemoving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const p = post.data;

  const submit = async () => {
    const body = draft.trim();
    if (!body || send.status === 'loading') return;
    tap();
    const c = await send.run(body);
    if (!c) {
      toast(errorText(send.lastError()), 'alert-circle-outline', colors.coral);
      return;
    }
    setDraft('');
    const page = comments.data;
    if (page) comments.mutate({ ...page, items: [...page.items, c], total: page.total + 1 });
    else comments.reload();
    if (p) post.mutate({ ...p, comments_count: p.comments_count + 1 });
    invalidateCampus('social:feed');
  };

  const deleteComment = (c: Comment) =>
    confirm('Delete comment?', 'This removes your comment for everyone.', async () => {
      setDeleting(c.id);
      try {
        await commentsApi.remove(c.id);
        const page = comments.data;
        if (page) comments.mutate({ ...page, items: page.items.filter((x) => x.id !== c.id), total: Math.max(0, page.total - 1) });
        if (p) post.mutate({ ...p, comments_count: Math.max(0, p.comments_count - 1) });
        invalidateCampus('social:feed');
        toast('Comment deleted', 'delete-outline');
      } catch (e) {
        toast(errorText(e), 'alert-circle-outline', colors.coral);
      } finally {
        setDeleting(null);
      }
    });

  const deletePost = () =>
    confirm('Delete post?', 'This removes the post, its likes and comments.', async () => {
      if (removing) return;
      setRemoving(true);
      try {
        await postsApi.remove(id);
      } catch (e) {
        setRemoving(false);
        toast(errorText(e), 'alert-circle-outline', colors.coral);
        return;
      }
      invalidateCampus('social:');
      toast('Post deleted', 'delete-outline');
      router.back();
    });

  return (
    <Screen tabBar={false}>
      <Header
        back
        title="Post"
        right={p?.is_mine ? <IconButton icon="delete-outline" color={removing ? colors.dim : colors.coral} onPress={deletePost} label="Delete post" /> : undefined}
      />
      {post.signedOut ? (
        <SignedOutState what="this post" />
      ) : !p && post.cause ? (
        <ErrorState cause={post.cause} onRetry={post.reload} feature="Posts" />
      ) : !p ? (
        <LoadingRows rows={1} height={360} />
      ) : (
        <>
          <PostCard key={p.id} post={p} open={false} onChange={(next) => post.mutate({ ...next, comments_count: p.comments_count })} />

          <Label style={{ marginTop: 6, marginBottom: 10 }}>{comments.data ? `Comments · ${comments.data.total}` : 'Comments'}</Label>

          <View style={styles.composer}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Add a comment…"
              placeholderTextColor={colors.dim}
              multiline
              maxLength={MAX_COMMENT}
              style={styles.input}
              accessibilityLabel="Comment"
            />
            <Button label={send.status === 'loading' ? 'Sending…' : 'Send'} size="sm" onPress={submit} disabled={!draft.trim() || send.status === 'loading'} />
          </View>
          {draft.length > MAX_COMMENT - 40 ? <Text style={styles.limit}>{draft.length}/{MAX_COMMENT}</Text> : null}

          {comments.signedOut ? null : !comments.data && comments.cause ? (
            <ErrorState cause={comments.cause} onRetry={comments.reload} feature="Comments" compact />
          ) : !comments.data ? (
            <LoadingRows rows={3} height={56} />
          ) : comments.data.items.length === 0 ? (
            <EmptyNote icon="comment-outline" title="No comments yet" body="Say something nice." />
          ) : (
            comments.data.items.map((c) => (
              <View key={c.id} style={styles.comment}>
                <PersonAvatar person={asPerson(c.author)} size={32} />
                <View style={{ flex: 1, marginLeft: 10 }}>
                  <Text style={styles.cName}>
                    {c.author.display_name} <Text style={styles.cTime}>· {shortTime(c.created_at)}</Text>
                  </Text>
                  <Text style={styles.cBody}>{c.body}</Text>
                </View>
                {c.can_delete && (
                  <Pressable onPress={() => deleteComment(c)} disabled={deleting === c.id} hitSlop={10} accessibilityRole="button" accessibilityLabel="Delete comment">
                    <Icon name="delete-outline" size={18} color={deleting === c.id ? colors.dim : colors.sub} />
                  </Pressable>
                )}
              </View>
            ))
          )}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 8, marginBottom: 4 },
  input: { flex: 1, minHeight: 40, maxHeight: 120, color: colors.text, fontFamily: fonts.regular, fontSize: 15, paddingHorizontal: 6, paddingTop: 8, textAlignVertical: 'top' },
  limit: { color: colors.dim, fontFamily: fonts.mono, fontSize: 11, textAlign: 'right', marginBottom: 4 },
  comment: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.line },
  cName: { color: colors.text, fontFamily: fonts.semibold, fontSize: 14 },
  cTime: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12 },
  cBody: { color: colors.text, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, marginTop: 2 },
});
