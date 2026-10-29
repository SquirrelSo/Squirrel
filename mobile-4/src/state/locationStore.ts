/**
 * Your own device location for the map. One shared watch (ref-counted), throttled: the store
 * only changes after you move ≥ 8 m (or accuracy changes a lot), so GPS noise never re-renders
 * anything but the "you" marker and the header. Presence is reported to the backend at most
 * once a minute (or after ~40 m).
 */
import { useSyncExternalStore } from 'react';
import * as Location from 'expo-location';
import type { LatLng } from '@/api/campus/types';
import { getLocationPermission, reportPresence, type LocationPermission } from '@/api/campus/map';

export type LocationState = { permission: LocationPermission | 'checking'; position: LatLng | null; accuracy_m: number | null; simulated: boolean };

let state: LocationState = { permission: 'checking', position: null, accuracy_m: null, simulated: false };
const listeners = new Set<() => void>();
let users = 0;
let sub: Location.LocationSubscription | null = null;
let reportPresenceEnabled = false;
let lastReport: { at: number; pos: LatLng } | null = null;

const R = 6_371_000;
const dist = (a: LatLng, b: LatLng) => {
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a[0] * Math.PI) / 180) * Math.cos((b[0] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

function setState(next: Partial<LocationState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
  maybeReport();
}

function maybeReport() {
  if (!reportPresenceEnabled || !state.position) return;
  const now = Date.now();
  if (lastReport && now - lastReport.at < 60_000 && dist(lastReport.pos, state.position) < 40) return;
  lastReport = { at: now, pos: state.position };
  void reportPresence({ lat: state.position[0], lng: state.position[1], accuracy_m: state.accuracy_m }).catch(() => undefined);
}

async function start(ask: boolean) {
  const permission = await getLocationPermission(ask);
  if (permission !== 'granted') {
    // Web / denied: no position. There is no simulated location in any build.
    setState({ permission });
    return;
  }
  setState({ permission, simulated: false });
  sub?.remove();
  sub = await Location.watchPositionAsync({ accuracy: Location.Accuracy.Balanced, timeInterval: 4000, distanceInterval: 8 }, (loc) => {
    const pos: LatLng = [loc.coords.latitude, loc.coords.longitude];
    const acc = loc.coords.accuracy ?? null;
    const moved = !state.position || dist(state.position, pos) >= 8;
    const accChanged = acc != null && (state.accuracy_m == null || Math.abs(acc - state.accuracy_m) > 15);
    if (moved || accChanged) setState({ position: pos, accuracy_m: acc });
  });
}

/** Start the shared watch (call from screens that show your position). Returns a stop function. */
export function startLocationWatch() {
  users++;
  if (users === 1) void start(false);
  return () => {
    users = Math.max(0, users - 1);
    if (!users) {
      sub?.remove();
      sub = null;
    }
  };
}

/** Ask for permission again (from a "Allow location" button). */
export const requestLocation = () => start(true);

/** Report your position to the backend for discovery while the map is open. */
export function setPresenceReporting(on: boolean) {
  reportPresenceEnabled = on;
  if (on) maybeReport();
}

export function useLocation(): LocationState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}

/** Current value without subscribing (for imperative actions like "recenter"). */
export const getLocationSnapshot = () => state;
