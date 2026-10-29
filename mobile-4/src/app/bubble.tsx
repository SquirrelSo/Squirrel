/**
 * YOUR BUBBLE — who's around you right now (campus-service /v1/bubble). Joining sends your position
 * once; the server keeps only the ~250 m cell and the zone it falls in, and you're listed only to
 * people in the cells around yours who are open to meet. Membership lapses after 15 minutes, so while
 * this screen is open and you're in, it re-joins every 5 minutes (keeping your activity as set).
 * The list follows bubble.* realtime events and refetches on focus. Never a coordinate or a distance.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { ApiError } from '@/api/client';
import { bubbleApi, errorCode } from '@/api/campus';
import { getUserLocation } from '@/api/campus/map';
import type { BubbleNearbyPage, BubbleState, PersonCard, PersonState } from '@/api/featureContracts';
import { OpenToMeetToggle } from '@/components/campus/Social';
import { EmptyNote, ErrorState, LoadingRows, SignedOutState, SourceBadge } from '@/components/campus/States';
import { shortTime } from '@/components/campus/territoryUi';
import { PersonRow } from '@/components/discover/Cards';
import { FilterChips } from '@/components/discover/FilterChips';
import { HiddenNote } from '@/components/discover/HiddenNote';
import { Button, Card, Display, Header, Icon, Kicker, Screen, SectionHeader } from '@/components/ui';
import { invalidateCampus, useAction, useCampus, useRealtime, useRefreshOnFocus } from '@/hooks/useCampus';
import {
  activityForJoin, applyBubbleEvent, BUBBLE_ACTIVITIES, BUBBLE_ACTIVITY_LABEL, expiresIn, joinOutcome, OUTCOME_TEXT, rejoinDelay, RETRY_MS, STATE_FILTERS, STATE_LABEL,
  type BubbleActivity, type JoinOutcome,
} from '@/logic/bubble';
import { appendPage } from '@/logic/discover';
import { getLocationSnapshot, requestLocation, startLocationWatch, useLocation } from '@/state/locationStore';
import { alpha, colors, fonts, radius } from '@/theme';

type Attempt = { outcome: JoinOutcome; cause: unknown; noLocation?: boolean };
const ACTIVITY_ICONS = { none: 'account-outline', run: 'run-fast', walk: 'walk', workout: 'arm-flex' } as const;
const FILTER_LABELS: Record<string, string> = { any: 'Everyone', ...STATE_LABEL };

export default function Bubble() {
  const st = useCampus<BubbleState>('bubble', () => bubbleApi.state());
  const inBubble = !!st.data?.in_bubble;
  const [filter, setFilter] = useState<PersonState | null>(null);
  const nearby = useCampus<BubbleNearbyPage>(`bubble:nearby:${filter ?? 'all'}`, () => bubbleApi.nearby(filter), { enabled: inBubble });
  useRefreshOnFocus(st.reload, 30_000);
  useRefreshOnFocus(nearby.reload, 30_000);
  const loc = useLocation();

  // Your position: watched only while this screen is in front.
  useFocusEffect(useCallback(() => startLocationWatch(), []));

  // What to join as. Follows the server's value while you're in; your pick otherwise.
  const [activity, setActivity] = useState<BubbleActivity>('none');
  const [synced, setSynced] = useState<string | null | undefined>(undefined);
  const serverActivity = st.data?.in_bubble ? st.data.activity_type ?? 'none' : undefined;
  if (serverActivity !== undefined && serverActivity !== synced) {
    setSynced(serverActivity);
    setActivity(serverActivity);
  }

  const [notice, setNotice] = useState<Attempt | null>(null);
  const lastJoin = useRef<number | null>(null);

  /** One join. `act` undefined (a refresh) leaves your activity as the server has it. Never throws. */
  const attempt = async (act: BubbleActivity | undefined): Promise<Attempt> => {
    const snap = getLocationSnapshot();
    const fix = snap.position ? snap : await getUserLocation().catch(() => null);
    if (!fix?.position) return { outcome: { kind: 'error' }, cause: null, noLocation: true };
    const acc = fix.accuracy_m;
    try {
      const res = await bubbleApi.join({
        lat: fix.position[0],
        lng: fix.position[1],
        ...(acc != null ? { accuracy_m: Math.min(5000, Math.max(0, acc)) } : {}),
        ...(act !== undefined ? { activity_type: activityForJoin(act) } : {}),
      });
      if (res.accepted) lastJoin.current = Date.now();
      st.mutate(res);
      invalidateCampus('bubble:nearby');
      return { outcome: joinOutcome({ ok: true, accepted: res.accepted, reason: res.reason }), cause: null };
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      return { outcome: joinOutcome({ ok: false, status, code: errorCode(e), retryAfterMs: e instanceof ApiError ? e.retryAfterMs : null }), cause: e };
    }
  };
  const attemptRef = useRef(attempt);
  useEffect(() => {
    attemptRef.current = attempt;
  });

  const join = useAction((act: BubbleActivity) => attemptRef.current(act));
  const onJoin = async (act: BubbleActivity) => {
    setNotice(null);
    const r = await join.run(act);
    if (r && r.outcome.kind !== 'joined') setNotice(r);
  };
  const leave = useAction(() => bubbleApi.leave());
  const onLeave = async () => {
    setNotice(null);
    // leave() resolves to nothing; null means it failed (shown below).
    if ((await leave.run()) !== null) {
      lastJoin.current = null;
      invalidateCampus('bubble');
    }
  };

  // Stay in while the screen is focused: re-join every 5 minutes; stop when you're out.
  const expiresRef = useRef(st.data?.expires_at ?? null);
  useEffect(() => {
    expiresRef.current = st.data?.expires_at ?? null;
  });
  useFocusEffect(
    useCallback(() => {
      if (!inBubble) return;
      let alive = true;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const schedule = (ms: number) => {
        timer = setTimeout(async () => {
          const r = await attemptRef.current(undefined);
          if (!alive) return;
          const o = r.outcome;
          if (o.kind === 'joined') schedule(rejoinDelay({ lastJoinedAt: lastJoin.current, expiresAt: expiresRef.current, now: Date.now() }));
          else if (o.kind === 'rate_limited') schedule(rejoinDelay({ lastJoinedAt: null, expiresAt: null, now: Date.now(), retryAfterMs: o.retryAfterMs }));
          else if (o.kind === 'error') schedule(RETRY_MS);
          else setNotice(r); // off campus or Open to Meet off: you're out; say why
        }, ms);
      };
      schedule(rejoinDelay({ lastJoinedAt: lastJoin.current, expiresAt: expiresRef.current, now: Date.now() }));
      return () => {
        alive = false;
        if (timer) clearTimeout(timer);
      };
    }, [inBubble]),
  );

  // The nearby list as shown: the first page, more pages, and realtime changes on top.
  const [list, setList] = useState<{ src: unknown; items: PersonCard[]; cursor: string | null } | null>(null);
  const [moreState, setMoreState] = useState<'idle' | 'loading' | 'error'>('idle');
  const page = nearby.data;
  const shown = list && list.src === page ? list : page ? { src: page, items: page.items, cursor: page.next_cursor } : null;
  const loadMore = async () => {
    if (!shown?.cursor || moreState === 'loading') return;
    setMoreState('loading');
    try {
      const next = await bubbleApi.nearby(filter, shown.cursor);
      setList({ src: shown.src, items: appendPage(shown.items, next.items, (c) => c.person.user_id), cursor: next.next_cursor });
      setMoreState('idle');
    } catch {
      setMoreState('error');
    }
  };

  // Counts come from the server: refetched shortly after a burst of events, not recomputed here.
  const countsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (countsTimer.current) clearTimeout(countsTimer.current);
  }, []);
  useRealtime((m) => {
    if (m.type !== 'bubble.user_joined' && m.type !== 'bubble.user_left' && m.type !== 'bubble.activity_started' && m.type !== 'bubble.activity_ended') return;
    if (!inBubble) return;
    if (shown) {
      const viewer = { zone_id: st.data?.zone?.id ?? null, activity: st.data?.activity_type ?? null };
      setList({ ...shown, items: applyBubbleEvent(shown.items, m.data, viewer, filter) });
    }
    if (countsTimer.current) clearTimeout(countsTimer.current);
    countsTimer.current = setTimeout(st.reload, 3_000);
  });

  const s = st.data;
  const located = !!loc.position;
  const otmOff = s?.hidden_reason === 'open_to_meet_off' || notice?.outcome.kind === 'open_to_meet_required';
  const afterOpenToMeet = (on: boolean) => {
    if (!on) return;
    setNotice(null);
    invalidateCampus('bubble');
    invalidateCampus('discover');
  };

  return (
    <Screen tabBar={false}>
      <Header back title="" right={<SourceBadge />} />
      <Kicker>Who’s around right now</Kicker>
      <Display size={40} style={{ marginTop: 4 }}>Your <Text style={{ color: colors.primary }}>bubble</Text></Display>

      <Card style={styles.privacy}>
        <Icon name="shield-lock-outline" size={20} color={colors.primary} />
        <Text style={styles.privacyText}>
          Only a ~250 m area and the zone you’re in are kept — your exact location is used once to find them, then discarded. People nearby see you as “Very close” or “Nearby”, never where you are. You drop out after 15 minutes unless this screen keeps you in.
        </Text>
      </Card>

      {st.signedOut ? (
        <SignedOutState what="your bubble" />
      ) : st.error && !s ? (
        <ErrorState cause={st.cause} onRetry={st.reload} feature="Your bubble" />
      ) : !s ? (
        <LoadingRows rows={3} height={72} style={{ marginTop: 16 }} />
      ) : otmOff ? (
        <View style={{ marginTop: 16, gap: 8 }}>
          <Text style={styles.body}>{OUTCOME_TEXT.open_to_meet_required}</Text>
          <OpenToMeetToggle value={false} onChange={afterOpenToMeet} />
        </View>
      ) : (
        <>
          {s.in_bubble ? (
            <Card style={[styles.state, { borderColor: alpha(colors.primary, 0.5) }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={styles.dot} />
                <Text style={styles.stateTitle}>In your bubble</Text>
                <Text style={styles.stateMeta}>{expiresIn(s.expires_at)}</Text>
              </View>
              <Text style={styles.body}>{s.zone ? `Zone: ${s.zone.name}` : 'Not inside a named zone'} · {BUBBLE_ACTIVITY_LABEL[s.activity_type ?? 'none']}</Text>
              <View style={styles.counts}>
                <Count n={s.counts.nearby} label="Nearby" />
                <Count n={s.counts.active_nearby} label="Active" />
                <Count n={s.counts.same_zone} label="Same zone" />
                <Count n={s.counts.same_activity} label="Same activity" />
              </View>
            </Card>
          ) : (
            <Text style={[styles.body, { marginTop: 16 }]}>You’re not in your bubble. Join to see who’s open to meet around you, and to be seen by them.</Text>
          )}

          <Text style={styles.label}>{s.in_bubble ? 'Your activity' : 'Join as'}</Text>
          <FilterChips label="Activity" items={BUBBLE_ACTIVITIES} value={activity} onChange={(v) => setActivity(v ?? 'none')} labels={BUBBLE_ACTIVITY_LABEL} icons={ACTIVITY_ICONS} />

          {!located && <LocationNote permission={loc.permission} />}

          <View style={styles.actions}>
            {!s.in_bubble ? (
              <Button label={join.status === 'loading' ? 'Joining…' : 'Join your bubble'} iconLeft="map-marker-radius-outline" onPress={() => onJoin(activity)} disabled={join.status === 'loading' || !located} style={{ flex: 1 }} />
            ) : (
              <>
                {activity !== (s.activity_type ?? 'none') && (
                  <Button label={join.status === 'loading' ? 'Saving…' : 'Update activity'} size="md" onPress={() => onJoin(activity)} disabled={join.status === 'loading' || !located} style={{ flex: 1 }} />
                )}
                <Button label={leave.status === 'loading' ? 'Leaving…' : 'Leave'} size="md" variant="secondary" iconLeft="exit-run" onPress={onLeave} disabled={leave.status === 'loading'} style={{ flex: 1 }} />
              </>
            )}
          </View>

          {notice && <Notice a={notice} onRetry={() => onJoin(activity)} />}
          {leave.status === 'error' && <ErrorState compact cause={leave.error} title="Couldn’t leave" onRetry={onLeave} feature="Your bubble" />}
          {s.hidden_reason === 'blocks_unreachable' && <HiddenNote reason={s.hidden_reason} onRetry={st.reload} />}

          {s.in_bubble && (
            <>
              <SectionHeader title="Around you" />
              <FilterChips label="Show" items={[null, ...STATE_FILTERS]} value={filter} onChange={setFilter} labels={FILTER_LABELS} />
              <View style={{ marginTop: 8 }}>
                {nearby.error && !page ? (
                  <ErrorState cause={nearby.cause} onRetry={nearby.reload} feature="Your bubble" />
                ) : !page || !shown ? (
                  <LoadingRows rows={3} height={72} />
                ) : page.hidden_reason ? (
                  <HiddenNote reason={page.hidden_reason} onRetry={nearby.reload} onBubble={() => onJoin(activity)} onOpenToMeet={afterOpenToMeet} />
                ) : shown.items.length ? (
                  <View style={{ gap: 8 }}>
                    {shown.items.map((c) => <PersonRow key={c.person.user_id} c={c} showStates />)}
                    {shown.cursor && (
                      <Button
                        label={moreState === 'loading' ? 'Loading…' : moreState === 'error' ? 'Couldn’t load — try again' : 'Show more'}
                        variant="secondary"
                        size="sm"
                        iconLeft={moreState === 'error' ? 'refresh' : 'chevron-down'}
                        disabled={moreState === 'loading'}
                        onPress={loadMore}
                        style={{ marginTop: 6, alignSelf: 'center' }}
                      />
                    )}
                  </View>
                ) : filter ? (
                  <EmptyNote icon="filter-remove-outline" title={`No one: ${STATE_LABEL[filter]}`} body="Nobody in your bubble matches this right now." action="Show everyone" onAction={() => setFilter(null)} />
                ) : (
                  <EmptyNote icon="map-marker-radius-outline" title="Just you for now" body="Nobody who’s open to meet is in the cells around you. People appear here as they join." action="Discover more" onAction={() => router.push('/discover')} />
                )}
                {page && <Text style={styles.fine}>Updated {shortTime(page.as_of)} · exact locations and distances are never shown.</Text>}
              </View>
            </>
          )}
        </>
      )}
    </Screen>
  );
}

function Count({ n, label }: { n: number; label: string }) {
  return (
    <View style={styles.count}>
      <Text style={styles.countN}>{n}</Text>
      <Text style={styles.countL}>{label}</Text>
    </View>
  );
}

/** A join that didn't take: off campus, too many tries, or a real error (with Retry). */
function Notice({ a, onRetry }: { a: Attempt; onRetry: () => void }) {
  const o = a.outcome;
  if (a.noLocation) return <EmptyNote icon="crosshairs-question" title="No location yet" body="Your position isn’t known yet, so you can’t join. Try again in a moment." action="Try again" onAction={onRetry} />;
  if (o.kind === 'off_campus') return <EmptyNote icon="map-marker-off-outline" title="You’re off campus" body={OUTCOME_TEXT.off_campus} />;
  if (o.kind === 'rate_limited') return <EmptyNote icon="timer-sand" title="Slow down" body={OUTCOME_TEXT.rate_limited} action="Try again" onAction={onRetry} />;
  if (o.kind === 'error') return <ErrorState compact cause={a.cause} title="Couldn’t join" onRetry={onRetry} feature="Your bubble" />;
  return null;
}

function LocationNote({ permission }: { permission: ReturnType<typeof useLocation>['permission'] }) {
  if (permission === 'checking' || permission === 'granted') return <Text style={styles.fine}>Finding your position…</Text>;
  const text =
    permission === 'services_off'
      ? 'Location services are off. Joining needs your position once — only a ~250 m area is kept.'
      : permission === 'unsupported'
        ? 'Joining needs the phone app’s GPS.'
        : 'Allow location to join. Your position is used once to find your ~250 m area, then discarded.';
  const action = permission === 'blocked' || permission === 'services_off' ? 'Settings' : permission === 'unsupported' ? undefined : 'Allow location';
  return <EmptyNote icon="map-marker-off-outline" title="Location needed" body={text} action={action} onAction={action === 'Settings' ? () => void Linking.openSettings() : () => void requestLocation()} />;
}

const styles = StyleSheet.create({
  privacy: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginTop: 14 },
  privacyText: { flex: 1, color: colors.dim, fontFamily: fonts.regular, fontSize: 12, lineHeight: 17 },
  state: { marginTop: 16, gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.green },
  stateTitle: { color: colors.text, fontFamily: fonts.labelBold, fontSize: 18, letterSpacing: 0.8, textTransform: 'uppercase', flex: 1 },
  stateMeta: { color: colors.dim, fontFamily: fonts.mono, fontSize: 11 },
  body: { color: colors.dim, fontFamily: fonts.regular, fontSize: 13, lineHeight: 18 },
  counts: { flexDirection: 'row', gap: 6, marginTop: 4 },
  count: { flex: 1, alignItems: 'center', borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, paddingVertical: 8 },
  countN: { color: colors.text, fontFamily: fonts.display, fontSize: 22 },
  countL: { color: colors.dim, fontFamily: fonts.label, fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase' },
  label: { color: colors.sub, fontFamily: fonts.label, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase', marginTop: 18 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  fine: { color: colors.mute, fontFamily: fonts.mono, fontSize: 10, textAlign: 'center', marginTop: 16 },
});
