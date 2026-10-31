/**
 * Photo upload: resize on the device, then Social's presigned flow (api/social.ts mediaApi):
 *   POST /v1/media/uploads → PUT the bytes to upload_url (with progress) → POST /v1/media/{id}/complete.
 * Photos are resized first (≤ 1600 px, JPEG), never uploaded at full resolution.
 *
 * Social stores photos for posts and avatars only, and has no moderation step: a completed upload
 * is usable at once. If a `moderation` verdict ever comes back, it's respected (see photoOutcome);
 * a missing one means there's nothing to wait for.
 */
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { mediaApi, type MediaStatus, type UploadPurpose } from '@/api/social';

export const MAX_EDGE_PX = 1600;
export const THUMB_EDGE_PX = 480;
const JPEG_QUALITY = 0.8;

export type PreparedPhoto = { uri: string; thumbUri: string; width: number; height: number; bytes: number; blob: Blob; mime: 'image/jpeg' };

async function render(uri: string, w: number, h: number, edge: number, compress: number) {
  const scale = Math.min(1, edge / Math.max(w, h));
  const ctx = ImageManipulator.manipulate(uri);
  if (scale < 1) ctx.resize(w >= h ? { width: Math.round(w * scale) } : { height: Math.round(h * scale) });
  const ref = await ctx.renderAsync();
  return ref.saveAsync({ format: SaveFormat.JPEG, compress });
}

/** Downscale and re-encode a picked image; returns the upload blob and a small preview. */
export async function preparePhoto(asset: { uri: string; width: number; height: number }): Promise<PreparedPhoto> {
  const full = await render(asset.uri, asset.width, asset.height, MAX_EDGE_PX, JPEG_QUALITY);
  const thumb = await render(full.uri, full.width, full.height, THUMB_EDGE_PX, 0.7);
  const blob = await (await fetch(full.uri)).blob();
  return { uri: full.uri, thumbUri: thumb.uri, width: full.width, height: full.height, bytes: blob.size, blob, mime: 'image/jpeg' };
}

/** PUT with progress (fetch can't report upload progress). */
function put(url: string, headers: Record<string, string>, body: Blob, onProgress: (f: number) => void, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('Upload failed — check your connection.'));
    xhr.onabort = () => reject(new Error('Upload cancelled.'));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(body);
  });
}

export async function uploadPhoto(photo: PreparedPhoto, purpose: UploadPurpose, onProgress: (f: number) => void, signal?: AbortSignal): Promise<MediaStatus> {
  const ticket = await mediaApi.createUpload(purpose, photo.mime, photo.bytes);
  await put(ticket.upload_url, ticket.headers, photo.blob, onProgress, signal);
  return mediaApi.complete(ticket.media_id);
}

export { photoOutcome } from '@/logic/photo';
