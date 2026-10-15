/**
 * PLAN A MEETUP — from a zone: when, where exactly (optional), and who. Invitees are people you've
 * crossed paths with: shared zones, Nearby, and your crews (logic/meetups inviteCandidates). A source
 * that can't load is simply left out. campus-service creates it (POST /v1/meetups) and notifies them.
 */
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { campusApi, errorKind, errorText } from '@/api/campus';
import type { ActiveNow, CrewDetail, SharedZonesIndex } from '@/api/campus/types';
import { PersonAvatar } from '@/components/campus/PersonAvatar';
import { LoadingRows } from '@/components/campus/States';
import { Button, Card, Display, Header, Icon, Kicker, PressScale, Screen, SectionHeader, tap } from '@/components/ui';
import { useCampus, useMe, useZones } from '@/hooks/useCampus';
import { startSlots } from '@/logic/battles';
import { inviteCandidates } from '@/logic/meetups';
import { useApp } from '@/state/AppState';
import { alpha, colors, fonts, radius } from '@/theme';

const MAX_INVITEES = 50;

export default function PlanMeetup() {
  const { zoneId } = useLocalSearchParams<{ zoneId?: string }>();
  const zones = useZones();
  const zone = zones.data?.find((z) => z.id === zoneId) ?? null;
  const me = useMe();
  const { toast } = useApp();
  const shared = useCampus<SharedZonesIndex>('shared-zones', () => campusApi.sharedZones());
  const active = useCampus<ActiveNow>('active-now', () => campusApi.activeNow());
  const crews = useCampus<CrewDetail[]>('crews:mine:members', async () => {
    const mine = await campusApi.crews({ scope: 'mine' });
    return Promise.all(mine.items.slice(0, 3).map((c) => campusApi.crew(c.id)));
  });
  const [slots] = useState(() => startSlots());
  const [slot, setSlot] = useState(0);
  const [place, setPlace] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const people = inviteCandidates(
    {
      shared: shared.data?.people,
      nearby: [...(active.data?.nearby ?? []), ...(active.data?.active ?? [])].map((a) => a.person),
      crews: crews.data?.map((c) => ({ name: c.name, members: c.members })),
    },
    me.data?.user_id ?? null,
  );
  const loading = !people.length && (shared.loading || active.loading || crews.loading);
  const toggle = (id: string) => {
    tap('select');
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < MAX_INVITEES ? [...p, id] : p));
  };

  const create = async () => {
    if (!zoneId || !picked.length || !slots[slot]) return;
    tap('impact');
    setCreating(true);
    setError(null);
    try {
      const m = await campusApi.createMeetup({ zone_id: zoneId, place_text: place.trim() || null, starts_at: slots[slot].at.toISOString(), invitee_ids: picked });
      toast(picked.length === 1 ? 'Invite sent' : `${picked.length} invites sent`, 'calendar-check', colors.primary);
      router.replace({ pathname: '/meetup/[id]', params: { id: m.id } });
    } catch (e) {
      setCreating(false);
      // Two different 404s: invitees campus-service doesn't know (the server names them) and a zone that
      // is no longer active ("Zone not found").
      const notFound = errorKind(e) === 'not_found';
      const unknownPeople = notFound && /campus map/i.test(e instanceof Error ? e.message : '');
      setError(unknownPeople ? `${errorText(e)}. Try without them.` : notFound ? 'This zone isn’t open for meetups any more. Pick another place on the map.' : errorText(e));
    }
  };

  return (
    <Screen tabBar={false}>
      <Header back title="" />
      <Kicker>Plan a meetup</Kicker>
      <Display size={34} style={{ marginTop: 4 }}>{zone?.name ?? 'On campus'}</Display>

      <SectionHeader title="When" />
      {slots.length ? (
        <View style={styles.chips}>
          {slots.map((s, i) => (
            <PressScale key={s.label} onPress={() => { tap('select'); setSlot(i); }} style={[styles.chip, slot === i && styles.chipOn]} scaleTo={0.96} accessibilityRole="button" accessibilityState={{ selected: slot === i }}>
              <Text style={[styles.chipText, slot === i && { color: colors.onPrimary }]}>{s.label}</Text>
            </PressScale>
          ))}
        </View>
      ) : (
        <Text style={styles.small}>No times left today. Come back tomorrow.</Text>
      )}

      <SectionHeader title="Where exactly" />
      <TextInput style={styles.input} value={place} onChangeText={setPlace} maxLength={240} placeholder={`Optional, e.g. by the ${zone?.name ?? 'entrance'} steps`} placeholderTextColor={colors.mute} accessibilityLabel="Where exactly (optional)" />

      <SectionHeader title={picked.length ? `Who · ${picked.length}` : 'Who'} />
      {loading ? (
        <LoadingRows rows={3} height={60} />
      ) : !people.length ? (
        <Card style={{ gap: 6 }}>
          <Icon name="account-search" size={22} color={colors.dim} />
          <Text style={styles.small}>Nobody to invite yet. People show up here once you’ve been in the same zones, are nearby right now, or share a crew.</Text>
        </Card>
      ) : (
        <View style={{ gap: 8 }}>
          {people.map((c) => {
            const on = picked.includes(c.person.user_id);
            return (
              <PressScale key={c.person.user_id} onPress={() => toggle(c.person.user_id)} style={[styles.row, on && styles.rowOn]} scaleTo={0.98} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={`${c.person.display_name}, ${c.why.join(', ')}`}>
                <PersonAvatar person={c.person} size={38} link={false} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{c.person.display_name}</Text>
                  <Text style={styles.why} numberOfLines={1}>{c.why.join(' · ')}</Text>
                </View>
                <Icon name={on ? 'checkbox-marked-circle' : 'checkbox-blank-circle-outline'} size={22} color={on ? colors.primary : colors.mute} />
              </PressScale>
            );
          })}
        </View>
      )}

      {!!error && <Text style={styles.err}>{error}</Text>}
      <Button
        label={creating ? 'Sending…' : picked.length ? `Invite ${picked.length === 1 ? people.find((p) => p.person.user_id === picked[0])?.person.display_name.split(' ')[0] ?? '1 person' : `${picked.length} people`}` : 'Pick who to invite'}
        iconLeft="send"
        disabled={creating || !picked.length || !slots.length || !zoneId}
        onPress={create}
        style={{ marginTop: 18 }}
      />
      <Text style={[styles.small, { textAlign: 'center', marginTop: 8 }]}>They get a notification and can accept or decline.</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: colors.card },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.text, fontFamily: fonts.label, fontSize: 14 },
  input: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, backgroundColor: colors.card, color: colors.text, fontFamily: fonts.medium, fontSize: 15, paddingHorizontal: 12, paddingVertical: 11 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: 10 },
  rowOn: { borderColor: colors.primary, backgroundColor: alpha(colors.primary, 0.06) },
  name: { color: colors.text, fontFamily: fonts.semibold, fontSize: 15 },
  why: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12, marginTop: 1 },
  small: { color: colors.dim, fontFamily: fonts.regular, fontSize: 13, lineHeight: 18 },
  err: { color: colors.coral, fontFamily: fonts.medium, fontSize: 13, marginTop: 12 },
});
