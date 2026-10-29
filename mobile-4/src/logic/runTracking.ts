import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { addRunTrackingBatch } from './runTrackingStore';

export {
  addRunTrackingBatch,
  addRunTrackingFix,
  beginRunTracking,
  clearRunTracking,
  endRunTracking,
  getRunTrackingSnapshot,
  noteRunLocationFix,
  prepareRunTracking,
  setRunTrackingPaused,
  subscribeRunTracking,
} from './runTrackingStore';
export type { RunSource, RunTrackingSnapshot } from './runTrackingStore';

export const RUN_LOCATION_TASK = 'squirrel-run-location-updates';

type LocationTaskData = { locations?: Location.LocationObject[] };

// Expo may launch this JavaScript bundle while the app UI is suspended. Keep registration at
// module scope so it runs before the route component renders.
TaskManager.defineTask<LocationTaskData>(RUN_LOCATION_TASK, async ({ data, error }) => {
  if (error || !data?.locations?.length) return;
  addRunTrackingBatch(data.locations.map((location) => ({
    lat: location.coords.latitude,
    lon: location.coords.longitude,
    t: location.timestamp,
    accuracy: location.coords.accuracy,
  })));
});

// A killed process cannot restore its in-memory run, so discard any native updates it left behind.
// Do this asynchronously so a slow or unavailable native task API never holds up app startup.
async function stopOrphanedRunLocationUpdates() {
  if (Platform.OS === 'web') return;
  try {
    if (await Location.hasStartedLocationUpdatesAsync(RUN_LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(RUN_LOCATION_TASK);
    }
  } catch {
    // No registered native task (or an unavailable module) is normal during startup.
  }
}

const startupCleanup = stopOrphanedRunLocationUpdates();

export function waitForRunTrackingStartupCleanup() {
  return startupCleanup;
}

export const BACKGROUND_LOCATION_OPTIONS: Location.LocationTaskOptions = {
  accuracy: Location.Accuracy.BestForNavigation,
  timeInterval: 1000,
  distanceInterval: 0,
  activityType: Location.ActivityType.Fitness,
  pausesUpdatesAutomatically: false,
  foregroundService: {
    notificationTitle: 'Squirrel run in progress',
    notificationBody: 'Recording your route. Tap to return to Squirrel.',
    notificationColor: '#D7FF1F',
  },
};
