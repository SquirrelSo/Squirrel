/**
 * Map data hooks. World geometry is loaded once (getMapData) and territories go into the shared
 * territory store; nearby players refresh on a gentle interval only while the Map is focused
 * (or on a realtime nudge), and seed the poke/friendship store.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import { getMapData, getNearbyUsers, type MapData } from '@/api/campus/map';
import type { NearbyPlayers } from '@/api/campus/types';
import { useCampus, useRealtime } from '@/hooks/useCampus';
import { seedRelationships } from '@/state/socialStore';
import { hydrateTerritories } from '@/state/territoryStore';

/** Zones + base map + territories in one request; territories are handed to the store. */
export function useMapWorld() {
  const r = useCampus<MapData>('map:world', () => getMapData());
  useEffect(() => {
    if (r.data) hydrateTerritories(r.data.territories);
  }, [r.data]);
  return r;
}

const PLAYERS_EVERY_MS = 30_000;
/** When the shared players request started: a list can't undo a poke made while it was in flight. */
let playersRequestedAt = 0;

export function useNearbyPlayers() {
  const r = useCampus<NearbyPlayers>('map:players', () => {
    playersRequestedAt = Date.now();
    return getNearbyUsers();
  });
  const { reload, data } = r;
  useEffect(() => {
    if (data) seedRelationships(data.players, playersRequestedAt);
  }, [data]);
  // Refresh while focused only; stop when the user leaves the Map.
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useFocusEffect(
    useCallback(() => {
      timer.current = setInterval(reload, PLAYERS_EVERY_MS);
      return () => {
        if (timer.current) clearInterval(timer.current);
      };
    }, [reload]),
  );
  const last = useRef(0);
  useRealtime((m) => {
    if (m.type !== 'players.updated' || Date.now() - last.current < 10_000) return;
    last.current = Date.now();
    reload();
  });
  return r;
}
