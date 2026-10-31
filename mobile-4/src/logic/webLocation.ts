/**
 * Web Geolocation, Screen Wake Lock, and browser event adapter.
 *
 * Implements browser-native location tracking via navigator.geolocation behind the app's
 * location abstraction. Manages Screen Wake Lock so mobile/desktop browsers don't sleep
 * during active runs, and tracks tab visibility and network connectivity.
 */

export type WebLocationPermission = 'granted' | 'undetermined' | 'denied' | 'blocked' | 'services_off' | 'unsupported';

export type WebLocationFix = {
  lat: number;
  lon: number;
  t: number;
  accuracy: number | null;
};

export type WebLocationErrorCode = 'permission_denied' | 'position_unavailable' | 'timeout' | 'unknown';

export type WebLocationError = {
  code: WebLocationErrorCode;
  message: string;
};

export type LocationSubscription = {
  remove: () => void;
};

export function isWebGeolocationAvailable(nav: any = typeof navigator !== 'undefined' ? navigator : undefined): boolean {
  return typeof nav !== 'undefined' && !!nav?.geolocation;
}

export async function getWebLocationPermission(
  nav: any = typeof navigator !== 'undefined' ? navigator : undefined,
): Promise<WebLocationPermission> {
  if (!isWebGeolocationAvailable(nav)) return 'unsupported';
  if (nav?.permissions?.query) {
    try {
      const status = await nav.permissions.query({ name: 'geolocation' });
      if (status.state === 'granted') return 'granted';
      if (status.state === 'prompt') return 'undetermined';
      if (status.state === 'denied') return 'denied';
    } catch {
      // Browsers or webviews with incomplete permissions query support fall back to undetermined.
    }
  }
  return 'undetermined';
}

export function requestWebLocationPermission(
  nav: any = typeof navigator !== 'undefined' ? navigator : undefined,
  timeoutMs = 10000,
): Promise<WebLocationPermission> {
  if (!isWebGeolocationAvailable(nav)) return Promise.resolve('unsupported');

  return new Promise<WebLocationPermission>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve('services_off');
    }, timeoutMs);

    nav.geolocation.getCurrentPosition(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve('granted');
      },
      (err: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err.code === 1 /* PERMISSION_DENIED */) resolve('denied');
        else if (err.code === 2 /* POSITION_UNAVAILABLE */ || err.code === 3 /* TIMEOUT */) resolve('services_off');
        else resolve('denied');
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}

export function mapGeolocationError(err: any): WebLocationError {
  if (!err) return { code: 'unknown', message: 'Unknown location error.' };
  if (err.code === 1 /* PERMISSION_DENIED */) {
    return { code: 'permission_denied', message: 'Location permission was denied. Allow location in your browser to record runs.' };
  }
  if (err.code === 2 /* POSITION_UNAVAILABLE */) {
    return { code: 'position_unavailable', message: 'Location unavailable. Ensure GPS is enabled on your device.' };
  }
  if (err.code === 3 /* TIMEOUT */) {
    return { code: 'timeout', message: 'Location request timed out. Searching for GPS signal…' };
  }
  return { code: 'unknown', message: err.message || 'Location error occurred.' };
}

export function watchWebPosition(
  onFix: (fix: WebLocationFix) => void,
  onError: (err: WebLocationError) => void,
  options: PositionOptions = { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
  nav: any = typeof navigator !== 'undefined' ? navigator : undefined,
): LocationSubscription {
  if (!isWebGeolocationAvailable(nav)) {
    onError({ code: 'position_unavailable', message: 'Geolocation is not supported in this browser.' });
    return { remove: () => {} };
  }

  const watchId = nav.geolocation.watchPosition(
    (pos: any) => {
      onFix({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        t: pos.timestamp || Date.now(),
        accuracy: pos.coords.accuracy ?? null,
      });
    },
    (err: any) => {
      onError(mapGeolocationError(err));
    },
    options,
  );

  return {
    remove: () => {
      try {
        nav.geolocation.clearWatch(watchId);
      } catch {
        // Safe disposal
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Screen Wake Lock API
// ---------------------------------------------------------------------------

export type WakeLockSentinelLike = {
  release: () => Promise<void>;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
  released?: boolean;
};

export function isWakeLockSupported(nav: any = typeof navigator !== 'undefined' ? navigator : undefined): boolean {
  return typeof nav !== 'undefined' && 'wakeLock' in nav && typeof nav.wakeLock?.request === 'function';
}

export async function requestScreenWakeLock(
  nav: any = typeof navigator !== 'undefined' ? navigator : undefined,
): Promise<WakeLockSentinelLike | null> {
  if (!isWakeLockSupported(nav)) return null;
  try {
    return await nav.wakeLock.request('screen');
  } catch {
    // Battery saver, permissions, or system policies may reject the wake lock.
    return null;
  }
}

export async function releaseScreenWakeLock(sentinel: WakeLockSentinelLike | null): Promise<void> {
  if (!sentinel) return;
  try {
    if (!sentinel.released) {
      await sentinel.release();
    }
  } catch {
    // Already released or tab closed
  }
}

// ---------------------------------------------------------------------------
// Tab Visibility & Online Listeners
// ---------------------------------------------------------------------------

export function isTabVisible(doc: any = typeof document !== 'undefined' ? document : undefined): boolean {
  return typeof doc === 'undefined' ? true : doc.visibilityState !== 'hidden';
}

export function isOnline(nav: any = typeof navigator !== 'undefined' ? navigator : undefined): boolean {
  return typeof nav === 'undefined' ? true : nav.onLine !== false;
}

export function addVisibilityListener(
  onChange: (visible: boolean) => void,
  doc: any = typeof document !== 'undefined' ? document : undefined,
): () => void {
  if (typeof doc === 'undefined' || !doc.addEventListener) return () => {};
  const handler = () => onChange(doc.visibilityState !== 'hidden');
  doc.addEventListener('visibilitychange', handler);
  return () => doc.removeEventListener('visibilitychange', handler);
}

export function addConnectivityListener(
  onOnline: () => void,
  onOffline: () => void,
  win: any = typeof window !== 'undefined' ? window : undefined,
): () => void {
  if (typeof win === 'undefined' || !win.addEventListener) return () => {};
  win.addEventListener('online', onOnline);
  win.addEventListener('offline', onOffline);
  return () => {
    win.removeEventListener('online', onOnline);
    win.removeEventListener('offline', onOffline);
  };
}
