/**
 * Reusable photo upload: ADD PHOTO → preview → UPLOAD (progress) → ready | failed (retry).
 * The parent only gets a photo once Social reports it stored. Social has no moderation step, so a
 * stored photo is ready at once; a verdict, if one is ever sent, is respected (rejected / checking).
 * Images are resized on the device (≤ 1600 px) and previewed from a small thumbnail.
 */
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { errorText, featureUnavailable, isEndpointAvailable } from '@/api/campus';
import { photoOutcome, preparePhoto, uploadPhoto, type PreparedPhoto } from '@/api/campus/media';
import type { MediaStatus, UploadPurpose } from '@/api/social';
import { Button, Icon, tap } from '@/components/ui';
import { alpha, colors, fonts, radius } from '@/theme';

export type ApprovedPhoto = { mediaId: string; uri: string; width: number; height: number };

type Phase =
  | { k: 'idle' }
  | { k: 'selecting' }
  | { k: 'preview'; photo: PreparedPhoto }
  | { k: 'uploading'; photo: PreparedPhoto }
  | { k: 'approved'; photo: PreparedPhoto; media: MediaStatus }
  | { k: 'rejected'; photo: PreparedPhoto; reason: string | null }
  | { k: 'checking'; photo: PreparedPhoto; media: MediaStatus }
  | { k: 'failed'; photo: PreparedPhoto | null; error: unknown };

export function PhotoUpload({ purpose, onChange, label = 'Add photo', autoUpload = false }: { purpose: UploadPurpose; onChange?: (p: ApprovedPhoto | null, busy: boolean) => void; label?: string; autoUpload?: boolean }) {
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const [progress] = useState(() => new Animated.Value(0));
  const abort = useRef<AbortController | null>(null);
  const cb = useRef(onChange);
  useEffect(() => {
    cb.current = onChange;
  });
  useEffect(() => () => abort.current?.abort(), []);

  // Tell the parent what it may use: only a stored photo; "busy" while anything is in flight.
  useEffect(() => {
    // A failed or rejected photo also blocks posting until it's retried or removed — never silently dropped.
    const busy = phase.k !== 'idle' && phase.k !== 'approved';
    const ok = phase.k === 'approved' ? { mediaId: phase.media.media_id, uri: phase.media.url?.startsWith('http') ? phase.media.url : phase.photo.uri, width: phase.photo.width, height: phase.photo.height } : null;
    cb.current?.(ok, busy);
  }, [phase]);

  const pick = async () => {
    tap();
    setPhase({ k: 'selecting' });
    try {
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, allowsMultipleSelection: false, exif: false });
      if (res.canceled || !res.assets?.[0]) return setPhase({ k: 'idle' });
      const photo = await preparePhoto(res.assets[0]);
      setPhase({ k: 'preview', photo });
      if (autoUpload) void upload(photo);
    } catch (e) {
      setPhase({ k: 'failed', photo: null, error: e });
    }
  };

  const upload = async (photo: PreparedPhoto) => {
    tap('impact');
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    progress.setValue(0);
    setPhase({ k: 'uploading', photo });
    try {
      const media = await uploadPhoto(photo, purpose, (f) => Animated.timing(progress, { toValue: f, duration: 150, useNativeDriver: false }).start(), ctrl.signal);
      if (ctrl.signal.aborted) return;
      const outcome = photoOutcome(media);
      if (outcome === 'usable') {
        tap('success');
        setPhase({ k: 'approved', photo, media });
      } else if (outcome === 'rejected') {
        setPhase({ k: 'rejected', photo, reason: media.rejection_reason ?? null });
      } else setPhase({ k: 'checking', photo, media });
    } catch (e) {
      if (!ctrl.signal.aborted) setPhase({ k: 'failed', photo, error: e });
    }
  };

  const reset = () => {
    abort.current?.abort();
    setPhase({ k: 'idle' });
  };

  // Media endpoint not live: keep the tile's place in the layout, disable only the upload action.
  if (!isEndpointAvailable('media')) {
    return (
      <Pressable disabled style={[styles.add, styles.addOff]} accessibilityRole="button" accessibilityState={{ disabled: true }} accessibilityLabel={`${label}. Photo uploads are not live yet.`}>
        <Icon name="camera-off-outline" size={26} color={colors.violet} />
        <Text style={[styles.addText, { color: colors.violet }]}>Photo uploads · Not live yet</Text>
        <Text style={styles.addSub}>Coming soon. You can still post without a photo.</Text>
      </Pressable>
    );
  }

  if (phase.k === 'idle' || phase.k === 'selecting') {
    return (
      <Pressable onPress={pick} disabled={phase.k === 'selecting'} style={styles.add} accessibilityRole="button" accessibilityLabel={label}>
        {phase.k === 'selecting' ? <ActivityIndicator color={colors.primary} /> : <Icon name="camera-plus-outline" size={26} color={colors.primary} />}
        <Text style={styles.addText}>{phase.k === 'selecting' ? 'Preparing…' : label}</Text>
        <Text style={styles.addSub}>Resized on your phone before it uploads.</Text>
      </Pressable>
    );
  }

  const photo = phase.photo;
  const unavailable = phase.k === 'failed' && featureUnavailable(phase.error);
  return (
    <View style={styles.box}>
      {photo && <Image source={{ uri: photo.thumbUri }} style={[styles.thumb, { aspectRatio: photo.width / photo.height }]} resizeMode="cover" accessibilityIgnoresInvertColors accessibilityLabel="Photo preview" />}
      {photo && phase.k !== 'approved' && <View style={styles.veil} />}
      <View style={styles.status}>
        {phase.k === 'preview' && (
          <>
            <Text style={styles.state}>Preview · only you can see this</Text>
            <View style={styles.row}>
              <Button label="Upload photo" size="sm" iconLeft="cloud-upload-outline" onPress={() => upload(phase.photo)} style={{ flex: 1 }} />
              <Button label="Remove" size="sm" variant="ghost" onPress={reset} />
            </View>
          </>
        )}
        {phase.k === 'uploading' && (
          <>
            <Text style={styles.state}>Uploading…</Text>
            <View style={styles.bar} accessibilityRole="progressbar">
              <Animated.View style={[styles.fill, { width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]} />
            </View>
            <Text style={styles.cancel} onPress={reset} accessibilityRole="button">Cancel</Text>
          </>
        )}
        {phase.k === 'checking' && (
          <View style={styles.row}>
            <ActivityIndicator size="small" color={colors.violet} />
            <Text style={[styles.state, { flex: 1 }]}>Still being checked. Post without it, or try again later.</Text>
            <Text style={styles.cancel} onPress={reset} accessibilityRole="button">Remove</Text>
          </View>
        )}
        {phase.k === 'approved' && (
          <View style={styles.row}>
            <Icon name="check-decagram" size={18} color={colors.primary} />
            <Text style={[styles.state, { flex: 1, color: colors.primary }]}>Uploaded · ready to share</Text>
            <Text style={styles.cancel} onPress={reset} accessibilityRole="button">Remove</Text>
          </View>
        )}
        {phase.k === 'rejected' && (
          <>
            <View style={styles.row}>
              <Icon name="image-off-outline" size={18} color={colors.coral} />
              <Text style={[styles.state, { flex: 1, color: colors.coral }]}>Photo couldn’t make it through.</Text>
            </View>
            {!!phase.reason && <Text style={styles.reason}>{phase.reason}</Text>}
            <Button label="Choose another" size="sm" variant="secondary" onPress={pick} />
          </>
        )}
        {phase.k === 'failed' && (
          <>
            <View style={styles.row}>
              <Icon name={unavailable ? 'progress-wrench' : 'alert-circle-outline'} size={18} color={unavailable ? colors.violet : colors.coral} />
              <Text style={[styles.state, { flex: 1, color: unavailable ? colors.violet : colors.coral }]}>{unavailable ? 'Photo uploads · Not live yet' : 'Upload failed.'}</Text>
            </View>
            {!unavailable && <Text style={styles.reason}>{errorText(phase.error)}</Text>}
            <View style={styles.row}>
              {phase.photo && !unavailable && <Button label="Retry" size="sm" iconLeft="refresh" onPress={() => upload(phase.photo!)} style={{ flex: 1 }} />}
              <Button label="Remove" size="sm" variant="ghost" onPress={reset} />
            </View>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  add: { alignItems: 'center', justifyContent: 'center', gap: 4, borderWidth: 1.5, borderStyle: 'dashed', borderColor: alpha(colors.primary, 0.5), borderRadius: radius.lg, paddingVertical: 20, backgroundColor: alpha(colors.primary, 0.04) },
  addText: { color: colors.primary, fontFamily: fonts.labelBold, fontSize: 15, letterSpacing: 1, textTransform: 'uppercase' },
  addOff: { borderColor: alpha(colors.violet, 0.45), backgroundColor: alpha(colors.violet, 0.05) },
  addSub: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12 },
  box: { borderRadius: radius.lg, overflow: 'hidden', borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card },
  thumb: { width: '100%', maxHeight: 280, backgroundColor: colors.bg2 },
  veil: { position: 'absolute', left: 0, right: 0, top: 0, height: 280, backgroundColor: 'rgba(6,6,6,0.25)' },
  status: { padding: 12, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  state: { color: colors.sub, fontFamily: fonts.medium, fontSize: 13 },
  reason: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12 },
  cancel: { color: colors.dim, fontFamily: fonts.labelBold, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase', paddingVertical: 2, paddingHorizontal: 4 },
  bar: { height: 6, borderRadius: 3, backgroundColor: colors.cardHi, overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: colors.primary },
});
