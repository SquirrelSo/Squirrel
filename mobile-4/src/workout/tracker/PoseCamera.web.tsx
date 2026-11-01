import { createElement, useEffect, useMemo, useRef, useLayoutEffect } from 'react';
import { View } from 'react-native';
import { POSE_ASSETS_URL } from '@/api/config';
import { parseTrackerMessage, trackerAssets } from './trackerHtml';
import { toPoseFrame, type PoseCameraProps } from './types';

/** Web build: same-origin tracker page in an iframe (/pose/tracker.html), talking over postMessage. */
export function PoseCamera({ active, skeleton, onFrame, onStatus, style }: PoseCameraProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const assets = useMemo(() => trackerAssets(POSE_ASSETS_URL), []);
  const src = useMemo(() => {
    const q = new URLSearchParams({
      facing: 'user',
      bundleUrl: assets.bundleUrl,
      wasmUrl: assets.wasmUrl,
      modelUrl: assets.modelUrl,
    });
    return `/pose/tracker.html?${q.toString()}`;
  }, [assets]);

  const handlers = useRef({ onFrame, onStatus });
  useLayoutEffect(() => {
    handlers.current = { onFrame, onStatus };
  });

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const m = parseTrackerMessage(event.data);
      if (!m) return;
      if (m.type === 'frame') handlers.current.onFrame(toPoseFrame(m));
      else handlers.current.onStatus(m.status, m.detail);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const send = (msg: object) => frameRef.current?.contentWindow?.postMessage(JSON.stringify(msg), '*');
  useEffect(() => send({ type: 'skeleton', color: skeleton }), [skeleton]);
  useEffect(() => send({ type: 'active', value: active }), [active]);

  const onLoad = () => {
    send({ type: 'skeleton', color: skeleton });
    send({ type: 'active', value: active });
  };

  return (
    <View style={style} pointerEvents="none">
      {createElement('iframe', {
        ref: frameRef,
        src,
        onLoad,
        allow: 'camera; autoplay',
        title: 'Body tracking',
        style: { border: 0, width: '100%', height: '100%', background: '#0a0a0a' },
      })}
    </View>
  );
}
