/** CREWS — discover, search, your crews, and create (when the backend allows it). */
import { useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { campusApi, type Crew } from '@/api/campus';
import { EmptyNote, ErrorState, LoadingRows, SourceBadge } from '@/components/campus/States';
import { CrewJoinButton } from '@/components/campus/CrewJoin';
import { Header, Icon, IconButton, PressScale, Screen, SearchBar, Segmented } from '@/components/ui';
import { useCampus, useConfig, useRefreshOnFocus } from '@/hooks/useCampus';
import { colors, fonts, radius } from '@/theme';

const SCOPES = ['Discover', 'My crews'] as const;

export default function Crews() {
  const [scope, setScope] = useState<(typeof SCOPES)[number]>('Discover');
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const apiScope = scope === 'My crews' ? 'mine' : 'all';
  const list = useCampus(`crews:${apiScope}:${term}`, () => campusApi.crews({ q: term, scope: apiScope }));
  useRefreshOnFocus(list.reload);
  const config = useConfig();
  const canCreate = !!config.data?.features.create_crew;
  const items = list.data?.items ?? [];

  return (
    <Screen tabBar={false} scroll={false}>
      <Header back title="Crews" right={<>{canCreate && <IconButton icon="plus" onPress={() => router.push('/crew/new')} label="Create crew" />}<SourceBadge /></>} />
      <View style={{ marginTop: 6 }}>
        <SearchBar placeholder="Search crews (running, night, hostel…)" value={q} onChangeText={setQ} />
      </View>
      <Segmented items={SCOPES} value={scope} onChange={setScope} />
      <FlatList
        data={items}
        keyExtractor={(c) => c.id}
        contentContainerStyle={{ gap: 10, paddingBottom: 40 }}
        renderItem={({ item }) => <CrewRow crew={item} onChanged={list.reload} />}
        ListEmptyComponent={
          list.signedOut ? (
            <EmptyNote icon="account-lock-outline" title="Sign in to see crews" action="Sign in" onAction={() => router.push('/sign-in')} />
          ) : list.error ? (
            <ErrorState cause={list.cause} onRetry={list.reload} />
          ) : list.loading ? (
            <LoadingRows rows={4} height={76} />
          ) : scope === 'My crews' ? (
            <EmptyNote icon="account-group-outline" title="No crews yet" body="Join one to hold territory together." action="Discover crews" onAction={() => setScope('Discover')} />
          ) : (
            <EmptyNote icon="magnify" title="No crews found" body={term ? `Nothing matches “${term}”.` : 'No crews on campus yet.'} action={canCreate ? 'Start a crew' : undefined} onAction={canCreate ? () => router.push('/crew/new') : undefined} />
          )
        }
      />
    </Screen>
  );
}

function CrewRow({ crew, onChanged }: { crew: Crew; onChanged: () => void }) {
  const c = crew.color ?? colors.primary;
  return (
    <PressScale onPress={() => router.push({ pathname: '/crew/[id]', params: { id: crew.id } })} style={styles.row} scaleTo={0.985} accessibilityLabel={crew.name}>
      <View style={[styles.icon, { backgroundColor: c }]}>
        <Icon name={(crew.icon as React.ComponentProps<typeof Icon>['name']) ?? 'account-group'} size={24} color={colors.onPrimary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.title} numberOfLines={1}>{crew.name}</Text>
        <Text style={styles.meta} numberOfLines={1}>
          {crew.members_count} members · {crew.territories_count} zones{crew.meets ? ` · ${crew.meets}` : ''}
        </Text>
        {!!crew.description && <Text style={styles.desc} numberOfLines={1}>{crew.description}</Text>}
      </View>
      <CrewJoinButton crew={crew} compact onChanged={onChanged} />
    </PressScale>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 12 },
  icon: { width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.text, fontFamily: fonts.bold, fontSize: 15 },
  meta: { color: colors.dim, fontFamily: fonts.mono, fontSize: 11, marginTop: 2 },
  desc: { color: colors.sub, fontFamily: fonts.regular, fontSize: 12, marginTop: 2 },
});
