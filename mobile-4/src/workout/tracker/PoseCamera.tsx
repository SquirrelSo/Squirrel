import { useEffect, useMemo, useRef, useLayoutEffect } from 'react';
import { View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { POSE_ASSETS_URL } from '@/api/config';
import { parseTrackerMessage, trackerAssets, trackerHtml } from './trackerHtml';
import { toPoseFrame, type PoseCameraProps } from './types';

/**
 * The phone's body tracking: the tracker page (trackerHtml.ts) in a WebView, with camera access.
 * The page runs MediaPipe on the phone's GPU and posts one message per tracked frame.
 * The https base URL gives the page a secure origin, which getUserMedia requires.
 */
export function PoseCamera({ active, skeleton, onFrame, onStatus, style }: PoseCameraProps) {
  const ref = useRef<WebView>(null);
  const html = useMemo(() => trackerHtml(trackerAssets(POSE_ASSETS_URL)), []);
  const handlers = useRef({ onFrame, onStatus });
  useLayoutEffect(() => {
    handlers.current = { onFrame, onStatus };
  });

  const send = (msg: object) => ref.current?.injectJavaScript(`window.__host && window.__host(${JSON.stringify(msg)}); true;`);
  useEffect(() => send({ type: 'skeleton', color: skeleton }), [skeleton]);
  useEffect(() => send({ type: 'active', value: active }), [active]);

  const onMessage = (event: WebViewMessageEvent) => {
    const m = parseTrackerMessage(event.nativeEvent.data);
    if (!m) return;
    if (m.type === 'frame') handlers.current.onFrame(toPoseFrame(m));
    else handlers.current.onStatus(m.status, m.detail);
  };

  return (
    <View style={style} pointerEvents="none">
      <WebView
        ref={ref}
        source={{ html, baseUrl: 'https://squirrelsocial.app/' }}
        originWhitelist={['*']}
        onMessage={onMessage}
        javaScriptEnabled
        // Camera inside the page: granted by the app's own camera permission (asked before this mounts).
        mediaCapturePermissionGrantType="grant"
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        style={{ flex: 1, backgroundColor: '#0a0a0a' }}
        onError={(e) => handlers.current.onStatus('error', e.nativeEvent.description)}
      />
    </View>
  );
}
