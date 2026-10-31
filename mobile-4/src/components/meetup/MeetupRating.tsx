/**
 * POST-MEETUP RATING. Eligibility (ended, you were in it, not yet rated), who can be
 * rated (other attendees — never yourself), the optional feedback dimensions and any trust score
 * all come from Dev A's API. Ratings are private; this screen never shows anyone else's.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { errorText, featureUnavailable } from '@/api/campus';
import { getMeetupRating, submitMeetupRating } from '@/api/campus/community';
import type { MeetupRatingResult, MeetupRatingState, TrustScore } from '@/api/campus/types';
import { PersonAvatar } from '@/components/campus/PersonAvatar';
import { ErrorState, LoadingRows, NotLiveYet } from '@/components/campus/States';
import { Button, Card, Display, Icon, SectionHeader, tap } from '@/components/ui';
import { invalidateCampus, useCampus } from '@/hooks/useCampus';
import { alpha, colors, fonts, radius } from '@/theme';

type Stars = 1 | 2 | 3 | 4 | 5;
const STAR_WORD = ['', 'Poor', 'Meh', 'Good', 'Great', 'Excellent'];

export function MeetupRating({ meetupId, meId }: { meetupId: string; meId: string | null }) {
  const r = useCampus<MeetupRatingState>(`meetup-rating:${meetupId}`, () => getMeetupRating(meetupId));
  const [stars, setStars] = useState<Record<string, Stars>>({});
  const [tags, setTags] = useState<Record<string, string[]>>({});
  const [key] = useState(() => `rating:${meetupId}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<MeetupRatingResult | null>(null);
  const st = r.data;

  // Unavailable ≠ error: the rest of the meetup screen works; only rating is "Not live yet".
  if (r.error && !st) return <View style={{ marginTop: 14 }}>{featureUnavailable(r.cause) ? <NotLiveYet name="Meetup ratings" compact body="Rating the people you met switches on once its backend is ready." /> : <ErrorState cause={r.cause} onRetry={r.reload} compact />}</View>;
  if (!st) return <LoadingRows rows={1} height={120} style={{ marginTop: 14 }} />;

  if (done || st.already_rated) return <Thanks trust={done?.trust_score ?? st.trust_score} />;
  if (!st.can_rate) {
    return st.reason ? (
      <View style={styles.note}>
        <Icon name="clock-star-four-points-outline" size={16} color={colors.dim} />
        <Text style={styles.noteText}>{st.reason}</Text>
      </View>
    ) : null;
  }

  const people = st.rateable.filter((p) => p.user_id !== meId); // belt and braces: never yourself
  const rated = Object.keys(stars).length;
  const submit = async () => {
    tap('impact');
    setSending(true);
    setError(null);
    try {
      const res = await submitMeetupRating(meetupId, { ratings: Object.entries(stars).map(([user_id, s]) => ({ user_id, stars: s, tags: tags[user_id] ?? [] })) }, key);
      tap('success');
      setDone(res);
      invalidateCampus(`meetup-rating:${meetupId}`); // coming back shows "already rated", not a stale form
    } catch (e) {
      setError(e);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <SectionHeader title="How was the meetup?" />
      <Card style={{ gap: 14 }}>
        {people.length === 0 && <Text style={styles.noteText}>Nobody else checked in, so there’s no one to rate.</Text>}
        {people.map((p) => {
          const n = stars[p.user_id] ?? 0;
          const first = p.display_name.split(' ')[0];
          return (
            <View key={p.user_id} style={{ gap: 8 }}>
              <View style={styles.person}>
                <PersonAvatar person={p} size={36} link={false} />
                <Text style={styles.name} numberOfLines={1}>{p.display_name}</Text>
                {n > 0 && <Text style={styles.word}>{STAR_WORD[n]}</Text>}
              </View>
              <View style={styles.stars} accessibilityRole="adjustable" accessibilityLabel={`Rate ${first}`} accessibilityValue={{ min: 0, max: 5, now: n }}>
                {([1, 2, 3, 4, 5] as Stars[]).map((v) => (
                  <Pressable key={v} onPress={() => { tap(); setStars((s) => ({ ...s, [p.user_id]: v })); }} hitSlop={6} accessibilityRole="button" accessibilityLabel={`${v} star${v > 1 ? 's' : ''} for ${first}`} style={styles.star}>
                    <Icon name={v <= n ? 'star' : 'star-outline'} size={30} color={v <= n ? colors.primary : colors.mute} />
                  </Pressable>
                ))}
              </View>
              {n > 0 && st.dimensions.length > 0 && (
                <View style={styles.tags}>
                  {st.dimensions.map((d) => {
                    const on = (tags[p.user_id] ?? []).includes(d.key);
                    return (
                      <Pressable
                        key={d.key}
                        onPress={() => { tap(); setTags((t) => ({ ...t, [p.user_id]: on ? (t[p.user_id] ?? []).filter((k) => k !== d.key) : [...(t[p.user_id] ?? []), d.key] })); }}
                        style={[styles.tag, on && styles.tagOn]}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: on }}
                        accessibilityLabel={`${d.label}, ${first}`}>
                        {on && <Icon name="check" size={13} color={colors.primary} />}
                        <Text style={[styles.tagText, on && { color: colors.primary }]}>{d.label}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </View>
          );
        })}
        <View style={styles.note}>
          <Icon name="lock-outline" size={14} color={colors.dim} />
          <Text style={styles.noteText}>Private. Nobody sees who rated them or how.</Text>
        </View>
        {!!error && <Text style={styles.err}>{errorText(error)}</Text>}
        <Button label={sending ? 'Sending…' : 'Submit'} iconLeft="send" disabled={sending || rated === 0} onPress={submit} />
      </Card>
    </>
  );
}

function Thanks({ trust }: { trust: TrustScore | null }) {
  return (
    <Card style={styles.thanks}>
      <Icon name="star-check" size={28} color={colors.primary} />
      <Display size={22} style={{ textAlign: 'center' }}>Thanks for the feedback</Display>
      <Text style={[styles.noteText, { textAlign: 'center' }]}>It helps keep campus meetups safe and friendly.</Text>
      {trust && (
        <View style={styles.trust} accessibilityLabel={`Your trust score: ${trust.value}, ${trust.label}`}>
          <Text style={styles.trustK}>Your trust score</Text>
          <Text style={styles.trustV}>{trust.value}</Text>
          <Text style={styles.trustL}>{trust.label}</Text>
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  person: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  name: { flex: 1, color: colors.text, fontFamily: fonts.semibold, fontSize: 15 },
  word: { color: colors.primary, fontFamily: fonts.labelBold, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' },
  stars: { flexDirection: 'row', gap: 4 },
  star: { padding: 2 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tag: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: colors.card },
  tagOn: { borderColor: colors.primary, backgroundColor: alpha(colors.primary, 0.08) },
  tagText: { color: colors.sub, fontFamily: fonts.label, fontSize: 13, letterSpacing: 0.6, textTransform: 'uppercase' },
  note: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 },
  noteText: { flex: 1, color: colors.dim, fontFamily: fonts.regular, fontSize: 12, lineHeight: 17 },
  err: { color: colors.coral, fontFamily: fonts.medium, fontSize: 13, textAlign: 'center' },
  thanks: { marginTop: 14, alignItems: 'center', gap: 6, borderColor: alpha(colors.primary, 0.4) },
  trust: { alignItems: 'center', marginTop: 8, backgroundColor: colors.cardHi, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, paddingVertical: 10, paddingHorizontal: 22 },
  trustK: { color: colors.dim, fontFamily: fonts.label, fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase' },
  trustV: { color: colors.violet, fontFamily: fonts.display, fontSize: 30, lineHeight: 34 },
  trustL: { color: colors.sub, fontFamily: fonts.labelBold, fontSize: 13, letterSpacing: 0.8, textTransform: 'uppercase' },
});
