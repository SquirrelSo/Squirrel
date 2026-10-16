/**
 * Map service. Screens call these, never fetch directly. Everything except the device
 * location comes from the backend (campusApi → the real backends) — except the base map,
 * which falls back to the static IISER Kolkata one (campusBaseMap.ts) when no backend serves it.
 */
import { Platform } from 'react-native';
import * as Location from 'expo-location';
import { campusApi, featureUnavailable } from '@/api/campus';
import { IISER_FEATURES, IISER_ZONES } from '@/api/campus/campusBaseMap';
import type { LatLng, MapFeatures, NearbyPlayers, PresenceUpdate, Territory, Zone } from '@/api/campus/types';

/** `source`: 'live' = a backend's world (campus-service, or the campus backend); 'base' = the static IISER base map (no territory state). */
export type MapData = { zones: Zone[]; features: MapFeatures; territories: Territory[]; source: 'live' | 'base' };

/**
 * The world (zones + base map) and current territory state in one call. With campus-service
 * configured (EXPO_PUBLIC_CAMPUS_SERVICE_URL) these three calls go there and the Map shows its live
 * zones and territory (campus-service has no roads / buildings, so they're drawn on plain ground).
 * When no backend serves the world (not configured, or the routes aren't deployed), the Map still
 * shows IISER Kolkata: the static base map, with NO territory state and no people. Real errors stay errors.
 */
export async function getMapData(): Promise<MapData> {
  try {
    const [zones, features, t] = await Promise.all([campusApi.zones(), campusApi.mapFeatures(), campusApi.territories()]);
    return { zones, features, territories: t.territories, source: 'live' };
  } catch (e) {
    if (!featureUnavailable(e)) throw e;
    return { zones: IISER_ZONES, features: IISER_FEATURES, territories: [], source: 'base' };
  }
}
export const getNearbyUsers = (): Promise<NearbyPlayers> => campusApi.nearbyPlayers();
export const getTerritories = () => campusApi.territories();
export const getZonePlayers = (zoneId: string) => campusApi.zonePlayers(zoneId);
export const searchPeople = (q: string) => campusApi.searchPeople(q);
export const reportPresence = (p: PresenceUpdate) => campusApi.updatePresence(p);

export type LocationPermission = 'granted' | 'undetermined' | 'denied' | 'blocked' | 'services_off' | 'unsupported';
export type UserLocation = { position: LatLng; accuracy_m: number | null; simulated: boolean };

export async function getLocationPermission(ask = false): Promise<LocationPermission> {
  // Browsers expose GPS through navigator.geolocation (expo-location wraps it); some embeds don't.
  if (Platform.OS === 'web' && (typeof navigator === 'undefined' || !navigator.geolocation)) return 'unsupported';
  try {
    if (!(await Location.hasServicesEnabledAsync())) return 'services_off';
    const p = ask ? await Location.requestForegroundPermissionsAsync() : await Location.getForegroundPermissionsAsync();
    if (p.status === 'granted') return 'granted';
    if (p.status === 'undetermined') return 'undetermined';
    return p.canAskAgain ? 'denied' : 'blocked';
  } catch {
    return 'services_off';
  }
}


/** One-off device location (your own, never shared with other users by the app). */
export async function getUserLocation(): Promise<UserLocation | null> {
  if ((await getLocationPermission()) !== 'granted') {
    return null;
  }
  const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  return { position: [loc.coords.latitude, loc.coords.longitude], accuracy_m: loc.coords.accuracy ?? null, simulated: false };
}
