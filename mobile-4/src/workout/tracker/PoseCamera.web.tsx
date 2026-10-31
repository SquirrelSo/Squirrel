import { createElement, useEffect, useMemo, useRef, useLayoutEffect } from 'react';
import { View } from 'react-native';
import { POSE_ASSETS_URL } from '@/api/config';
import { parseTrackerMessage, trackerAssets, trackerHtml } from './trackerHtml';
import { toPoseFrame, type PoseCameraProps } from './types';

/** Web build: the same tracker page in an iframe (camera allowed), talking over postMessage. */
export function PoseCamera({ active, skeleton, onFrame, onStatus, style }: PoseCameraProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const html = useMemo(() => trackerHtml(trackerAssets(POSE_ASSETS_URL)), []);
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

  return (
    <View style={style} pointerEvents="none">
      {createElement('iframe', {
        ref: frameRef,
        srcDoc: html,
        allow: 'camera; autoplay',
        title: 'Body tracking',
        style: { border: 0, width: '100%', height: '100%', background: '#0a0a0a' },
      })}
    </View>
  );
}
