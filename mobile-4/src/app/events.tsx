/** EVENTS — upcoming on campus and the ones you're going to, from the backend. */
import { useState } from 'react';
import { FlatList, View } from 'react-native';
import { router } from 'expo-router';
import { campusApi } from '@/api/campus';
import { EventRow } from '@/components/campus/EventRow';
import { isStudyBreak, StudyBreakCard } from '@/components/events/StudyBreak';
import { EmptyNote, ErrorState, LoadingRows, SourceBadge } from '@/components/campus/States';
import { Header, IconButton, Screen, Segmented } from '@/components/ui';
import { useCampus, useConfig, useRealtime, useRefreshOnFocus } from '@/hooks/useCampus';
import { FeatureGate, SoonScreen } from '@/components/Locked';

const TABS = ['Upcoming', 'Going'] as const;

export default function EventsRoute() {
  return (
    <FeatureGate feature="events" fallback={<SoonScreen title="Events" body="Campus events, study-break walks and RSVPs — switching on soon." onBack={() => (router.canGoBack() ? router.back() : router.replace('/home'))} />}>
      <Events />
    </FeatureGate>
  );
}

function Events() {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Upcoming');
  const scope = tab === 'Going' ? 'mine' : 'upcoming';
  const list = useCampus(`events:${scope}`, () => campusApi.events({ scope }));
  const canPlan = useConfig().data?.features.create_event ?? false;
  useRefreshOnFocus(list.reload);
  // Participant counts move live; patch them in place rather than refetching the list.
  useRealtime((m) => {
    if (m.type !== 'event.updated' || !list.data) return;
    const items = list.data.items.map((e) => (e.id === m.data.event_id ? { ...e, participants_count: m.data.participants_count } : e));
    list.mutate({ ...list.data, items });
  });
  const all = list.data?.items ?? [];
  // Upcoming leads with the next study-break walk: spontaneous, twenty minutes, no planning.
  const featured = tab === 'Upcoming' ? (all.find(isStudyBreak) ?? null) : null;
  const items = featured ? all.filter((e) => e.id !== featured.id) : all;
  return (
    <Screen tabBar={false} scroll={false}>
      <Header back title="Events" right={<>{canPlan && <IconButton icon="calendar-plus" onPress={() => router.push('/event/plan')} label="Plan a meetup" />}<IconButton icon="calendar-check" onPress={() => router.push('/meetups')} label="Meetups and check-in" /><SourceBadge /></>} />
      <Segmented items={TABS} value={tab} onChange={setTab} />
      <FlatList
        data={items}
        keyExtractor={(e) => e.id}
        contentContainerStyle={{ gap: 10, paddingBottom: 40 }}
        renderItem={({ item }) => <EventRow event={item} />}
        ListHeaderComponent={featured ? <StudyBreakCard event={featured} /> : null}
        ListEmptyComponent={
          <View>
            {list.signedOut ? (
              <EmptyNote icon="account-lock-outline" title="Sign in to see events" action="Sign in" onAction={() => router.push('/sign-in')} />
            ) : list.error ? (
              <ErrorState cause={list.cause} onRetry={list.reload} />
            ) : list.loading ? (
              <LoadingRows rows={4} height={82} />
            ) : tab === 'Going' ? (
              <EmptyNote icon="calendar-blank-outline" title="No plans yet" body="RSVP to an event and it shows up here." action="See upcoming" onAction={() => setTab('Upcoming')} />
            ) : (
              <EmptyNote icon="calendar-blank-outline" title="Nothing scheduled" body="No events on campus right now. Crews post them here." />
            )}
          </View>
        }
      />
    </Screen>
  );
}
