/**
 * DISCOVER — who and what is around campus, from campus-service (GET /v1/discover): Nearby,
 * Active now, Your battles, Zones, Crews; "See all" opens one section as a paged list with the
 * filters its route accepts (/discover?section=nearby). People appear only with a current Open to
 * Meet and are never blocked either way; proximity is words, never coordinates or a distance.
 * A held-back section (`hidden_reason`) says why and how to fix it instead of looking empty.
 */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { discoverApi, type DiscoverBattle, type DiscoverItem } from '@/api/campus';
import type { ActivityType, DiscoverCrew, DiscoverOverview, DiscoverZone, PersonCard } from '@/api/featureContracts';
import { EmptyNote, ErrorState, LoadingRows, SignedOutState, SourceBadge } from '@/components/campus/States';
import { shortTime } from '@/components/campus/territoryUi';
import { BattleRow, CrewRow, PersonRow, ZoneRow } from '@/components/discover/Cards';
import { FilterChips } from '@/components/discover/FilterChips';
import { HiddenNote } from '@/components/discover/HiddenNote';
import { Button, Display, Header, Kicker, Screen, SectionHeader } from '@/components/ui';
import { invalidateCampus, useCampus, useRefreshOnFocus } from '@/hooks/useCampus';
import {
  ACTIVITY_WORDS, appendPage, BATTLE_TYPE_LABEL, BATTLE_TYPES, DISCOVER_SECTIONS, hiddenInfo, SECTION_SORTS, SECTION_TITLE, sectionAccepts, SORT_LABEL, zoneChoices,
  type DiscoverFilters, type DiscoverSection,
} from '@/logic/discover';
import { colors, fonts } from '@/theme';

type Item = DiscoverItem[DiscoverSection];

const EMPTY: Record<DiscoverSection, { icon: React.ComponentProps<typeof EmptyNote>['icon']; title: string; body: string }> = {
  nearby: { icon: 'map-marker-radius-outline', title: 'No one nearby', body: 'Nobody who’s open to meet is close to you right now.' },
  active: { icon: 'sleep', title: 'Quiet right now', body: 'Nobody visible is out moving. Be the first — start a run.' },
  challenges: { icon: 'sword-cross', title: 'No battles yet', body: 'Battles you start, are challenged to, or your crew is in show up here.' },
  zones: { icon: 'map-outline', title: 'No zones here', body: 'Nothing matches this view yet.' },
  crews: { icon: 'account-group-outline', title: 'No crews hold zones yet', body: 'Crews show up here once they hold a zone.' },
};

const keyOf = (s: DiscoverSection, i: Item): string =>
  s === 'nearby' || s === 'active' ? (i as PersonCard).person.user_id : s === 'challenges' ? (i as DiscoverBattle).id : s === 'zones' ? (i as DiscoverZone).zone.id : (i as DiscoverCrew).crew.id;

function Row({ section, item }: { section: DiscoverSection; item: Item }) {
  if (section === 'nearby' || section === 'active') return <PersonRow c={item as PersonCard} />;
  if (section === 'challenges') return <BattleRow b={item as DiscoverBattle} />;
  if (section === 'zones') return <ZoneRow z={item as DiscoverZone} />;
  return <CrewRow c={item as DiscoverCrew} />;
}

export default function Discover() {
  const { section } = useLocalSearchParams<{ section?: string }>();
  const s = DISCOVER_SECTIONS.find((x) => x === section);
  return s ? <SectionList key={s} section={s} /> : <Overview />;
}

function Overview() {
  const r = useCampus<DiscoverOverview<DiscoverBattle>>('discover', () => discoverApi.overview());
  useRefreshOnFocus(r.reload, 30_000);
  const d = r.data;
  return (
    <Screen tabBar={false}>
      <Header back title="" right={<SourceBadge />} />
      <Kicker>Around campus</Kicker>
      <Display size={40} style={{ marginTop: 4 }}>Dis<Text style={{ color: colors.primary }}>cover</Text></Display>
      <Text style={styles.lead}>People open to meet, battles you’re in, and what’s busy on campus.</Text>

      {r.signedOut ? (
        <SignedOutState what="Discover" />
      ) : r.error && !d ? (
        <ErrorState cause={r.cause} onRetry={r.reload} feature="Discover" />
      ) : !d ? (
        <LoadingRows rows={5} height={72} style={{ marginTop: 16 }} />
      ) : (
        <>
          {DISCOVER_SECTIONS.map((s) => {
            const items = (d[s] ?? []) as Item[];
            const reason = d.reasons?.[s] ?? null;
            // Crews with names missing are still listed; every other reason leaves the section empty on purpose.
            const partial = reason === 'crew_names_unavailable';
            return (
              <View key={s}>
                <SectionHeader title={SECTION_TITLE[s]} action="See all" onAction={() => router.push({ pathname: '/discover', params: { section: s } })} />
                {reason && !partial ? (
                  <HiddenNote reason={reason} onRetry={r.reload} onOpenToMeet={() => invalidateCampus('discover')} />
                ) : items.length ? (
                  <View style={{ gap: 8 }}>
                    {partial && <Text style={styles.note}>{hiddenInfo(reason)?.body}</Text>}
                    {items.map((i) => <Row key={keyOf(s, i)} section={s} item={i} />)}
                  </View>
                ) : (
                  <EmptyNote {...EMPTY[s]} />
                )}
              </View>
            );
          })}
          <Text style={styles.fine}>Updated {shortTime(d.as_of)} · exact locations and distances are never shown.</Text>
        </>
      )}
    </Screen>
  );
}

const ACTIVITY_CHOICES: (ActivityType | null)[] = [null, 'run', 'walk', 'workout'];
const ACTIVITY_LABELS: Record<string, string> = { any: 'Anyone', ...ACTIVITY_WORDS };
const ACTIVITY_ICONS = { run: 'run-fast', walk: 'walk', workout: 'arm-flex' } as const;

/** One section, paged with the server's cursor ("Show more"), with the filters its route accepts. */
function SectionList({ section }: { section: DiscoverSection }) {
  const sorts = SECTION_SORTS[section];
  const [filters, setFilters] = useState<DiscoverFilters>(() => ({ sort: sorts?.[0] }));
  // The chosen zone's name, so it stays a choice while the list is filtered to it.
  const [zone, setZone] = useState<{ id: string; name: string } | null>(null);
  const r = useCampus(`discover:${section}:${JSON.stringify(filters)}`, () => discoverApi.section(section, filters));
  useRefreshOnFocus(r.reload, 30_000);
  // Pages past the first: kept for the first page they were loaded after (a refetch starts over).
  const [more, setMore] = useState<{ src: unknown; items: Item[]; cursor: string | null } | null>(null);
  const [moreState, setMoreState] = useState<'idle' | 'loading' | 'error'>('idle');
  const d = r.data;
  const extra = more && more.src === d ? more : null;
  const items = (extra ? extra.items : d?.items ?? []) as Item[];
  const cursor = extra ? extra.cursor : d?.next_cursor ?? null;
  const loadMore = async () => {
    if (!d || !cursor || moreState === 'loading') return;
    setMoreState('loading');
    try {
      const page = await discoverApi.section(section, filters, cursor);
      setMore({ src: d, items: appendPage(items, page.items as Item[], (i) => keyOf(section, i)), cursor: page.next_cursor });
      setMoreState('idle');
    } catch {
      setMoreState('error');
    }
  };
  const set = (patch: DiscoverFilters) => setFilters((f) => ({ ...f, ...patch }));

  const zonesHere = sectionAccepts(section, 'zone_id')
    ? zoneChoices([...(section === 'challenges' ? (items as DiscoverBattle[]).map((b) => b.zone) : (items as PersonCard[]).map((c) => c.zone)), zone])
    : [];
  const reason = d?.hidden_reason ?? null;
  const partial = reason === 'crew_names_unavailable';
  const filtered = !!(filters.activity_type || filters.zone_id || filters.type);

  return (
    <Screen tabBar={false}>
      <Header back title={SECTION_TITLE[section]} right={<SourceBadge />} />

      {sectionAccepts(section, 'activity_type') && (
        <FilterChips label="Activity" items={ACTIVITY_CHOICES} value={filters.activity_type ?? null} onChange={(v) => set({ activity_type: v ?? undefined })} labels={ACTIVITY_LABELS} icons={ACTIVITY_ICONS} />
      )}
      {sectionAccepts(section, 'type') && (
        <FilterChips label="Battle type" items={[null, ...BATTLE_TYPES]} value={(filters.type as (typeof BATTLE_TYPES)[number] | undefined) ?? null} onChange={(v) => set({ type: v ?? undefined })} labels={{ any: 'All battles', ...BATTLE_TYPE_LABEL }} />
      )}
      {zonesHere.length > 0 && (
        <FilterChips
          label="Zone"
          items={[null, ...zonesHere.map((z) => z.id)]}
          value={filters.zone_id ?? null}
          onChange={(v) => {
            setZone(zonesHere.find((z) => z.id === v) ?? null);
            set({ zone_id: v ?? undefined });
          }}
          labels={{ any: 'Any zone', ...Object.fromEntries(zonesHere.map((z) => [z.id, z.name])) }}
        />
      )}
      {sorts && (
        <FilterChips label="Sort" items={sorts} value={filters.sort ?? sorts[0]} onChange={(v) => set({ sort: v ?? sorts[0] })} labels={SORT_LABEL} />
      )}

      <View style={{ marginTop: 12 }}>
        {r.signedOut ? (
          <SignedOutState what="Discover" />
        ) : r.error && !d ? (
          <ErrorState cause={r.cause} onRetry={r.reload} feature="Discover" />
        ) : !d ? (
          <LoadingRows rows={5} height={72} />
        ) : reason && !partial ? (
          <HiddenNote reason={reason} onRetry={r.reload} onOpenToMeet={() => invalidateCampus('discover')} />
        ) : items.length ? (
          <View style={{ gap: 8 }}>
            {partial && <Text style={styles.note}>{hiddenInfo(reason)?.body}</Text>}
            {section === 'challenges' && (d as { crew_battles_unavailable?: boolean }).crew_battles_unavailable && <Text style={styles.note}>Your crews couldn’t be checked, so crew battles are left out for now.</Text>}
            {items.map((i) => <Row key={keyOf(section, i)} section={section} item={i} />)}
            {cursor && (
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
        ) : filtered ? (
          <EmptyNote icon="filter-remove-outline" title="Nothing matches" body="No one and nothing fits these filters right now." action="Clear filters" onAction={() => { setZone(null); setFilters({ sort: filters.sort }); }} />
        ) : (
          <EmptyNote {...EMPTY[section]} />
        )}
        {d && <Text style={styles.fine}>Updated {shortTime(d.as_of)} · exact locations and distances are never shown.</Text>}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  lead: { color: colors.dim, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, marginTop: 6 },
  note: { color: colors.gold, fontFamily: fonts.mono, fontSize: 11, lineHeight: 16 },
  fine: { color: colors.mute, fontFamily: fonts.mono, fontSize: 10, textAlign: 'center', marginTop: 16 },
});
