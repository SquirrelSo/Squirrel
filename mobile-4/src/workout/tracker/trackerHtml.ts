/**
 * The body-tracking page the workout screen runs on the phone (a WebView; an iframe on web).
 *
 * It is the browser coach's proven tracking (Exercise_Mechanics--main/frontend-react/src/pose):
 * MediaPipe PoseLandmarker (lite model, GPU with a CPU fallback, one pose, VIDEO mode) on the front
 * camera, smoothed by the same One Euro filter (MIN_CUTOFF 1.5, BETA 15, D_CUTOFF 1), drawn as a
 * mirrored selfie view with a skeleton. The WHOLE camera frame is shown (letterboxed, not cropped
 * to fill the screen): a landscape camera on a portrait phone would otherwise lose most of its
 * width, so the view looks zoomed in and the person cannot see what the tracker sees.
 * Each tracked frame goes to the app as
 *   { type: 'frame', t, ms, w, h, lm: [x, y, z, v] × 33 (normalized, UN-mirrored) }   or   lm: null (no body)
 * where t is the page's capture time (ms): the app times frames by when they were taken, not by
 * when a message crossed into it (WebView messages can arrive late or in bursts); ms is how long
 * the model took on this frame. The app turns it into the server's pixel keypoints (workout/coach.ts).
 *
 * Measured on real footage (see the report in the commit that added this): the model finds a
 * person at every size from ~12 % of the frame height up to a body cut off at the edges, in bright,
 * dim and backlit scenes, and camera resolution (360p-1080p) makes no difference to it (it resizes
 * every frame to its own input). So the camera stays at 1280x720 and the model at lite.
 *
 * Temporary loss: a frame without a body is reported honestly (lm: null), but the smoothing is only
 * dropped after LOST_AFTER consecutive misses, so one bad frame does not restart the filters.
 * Visibility is smoothed too (VIS_ALPHA), so a joint hovering at the server's 0.5 floor does not
 * flicker in and out.
 *
 * App → page:  { type: 'skeleton', color: 'green' | 'red' | 'white' }, { type: 'active', value: bool }
 * Page → app:  { type: 'status', status: 'loading' | 'ready' | 'denied' | 'error', detail? }, frames.
 */

export const TASKS_VISION_VERSION = '0.10.35';

export type TrackerAssets = { bundleUrl: string; wasmUrl: string; modelUrl: string };

/** The browser coach's sources: jsDelivr for MediaPipe, Google's model storage for the model.
 *  EXPO_PUBLIC_POSE_ASSETS_URL points all three at one self-hosted folder instead. */
export function trackerAssets(base?: string): TrackerAssets {
  const self = base?.trim().replace(/\/+$/, '');
  if (self) return { bundleUrl: `${self}/vision_bundle.mjs`, wasmUrl: `${self}/wasm`, modelUrl: `${self}/pose_landmarker_lite.task` };
  const cdn = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}`;
  return {
    bundleUrl: `${cdn}/vision_bundle.mjs`,
    wasmUrl: `${cdn}/wasm`,
    modelUrl: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  };
}

export function trackerHtml(assets: TrackerAssets, facing: 'user' | 'environment' = 'user'): string {
  const config = JSON.stringify({ ...assets, facing });
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
  html,body{margin:0;height:100%;background:#0a0a0a;overflow:hidden}
  video,canvas{position:absolute;inset:0;width:100%;height:100%}
  video{object-fit:contain}
  .mirror{transform:scaleX(-1)}
</style></head>
<body>
<video id="v" playsinline muted autoplay></video>
<canvas id="c"></canvas>
<script type="module">
const CFG = ${config};
const post = (m) => {
  const s = JSON.stringify(m);
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(s);
  else window.parent.postMessage(s, '*');
};
const video = document.getElementById('v'), canvas = document.getElementById('c'), ctx = canvas.getContext('2d');
if (CFG.facing === 'user') { video.classList.add('mirror'); canvas.classList.add('mirror'); }
let active = true, color = 'white';
const onHost = (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'skeleton') color = msg.color;
  if (msg.type === 'active') active = !!msg.value;
};
window.__host = onHost;
window.addEventListener('message', (e) => { try { onHost(typeof e.data === 'string' ? JSON.parse(e.data) : e.data); } catch (_) {} });

// One Euro filter, as frontend-react/src/pose/oneEuro.ts (Casiez et al., CHI 2012).
const MIN_CUTOFF = 1.5, BETA = 15.0, D_CUTOFF = 1.0;
class LowPass { constructor(){this.has=false;this.raw=0;this.y=0} f(x,a){const y=this.has?a*x+(1-a)*this.y:x;this.has=true;this.raw=x;this.y=y;return y} reset(){this.has=false} }
class OneEuro {
  constructor(){this.x=new LowPass();this.dx=new LowPass();this.t=null}
  a(cut,dt){const tau=1/(2*Math.PI*cut);return 1/(1+tau/dt)}
  f(v,t){ if(this.t===null){this.t=t;return this.x.f(v,1)}
    const dt=Math.max(1e-3,t-this.t); this.t=t;
    const d=this.x.has?(v-this.x.raw)/dt:0; const ed=this.dx.f(d,this.a(D_CUTOFF,dt));
    return this.x.f(v,this.a(MIN_CUTOFF+BETA*Math.abs(ed),dt)); }
  reset(){this.x.reset();this.dx.reset();this.t=null}
}
const bank = () => Array.from({length:33}, () => new OneEuro());
let fx = bank(), fy = bank(), fz = bank();
// Visibility: exponential smoothing both ways (never raised above what the model reports over time).
const VIS_ALPHA = 0.4;
let vis = null;
const resetFilter = () => { fx.forEach(f=>f.reset()); fy.forEach(f=>f.reset()); fz.forEach(f=>f.reset()); vis = null; };
// Consecutive frames without a body before the smoothing is dropped (~0.25 s at 30 fps).
const LOST_AFTER = 8;
let missed = 0;

const EDGES = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28],[27,29],[29,31],[27,31],[28,30],[30,32],[28,32],[15,17],[15,19],[15,21],[16,18],[16,20],[16,22],[0,11],[0,12]];
const COLORS = { green: '#3DDC84', red: '#FF3B5C', white: 'rgba(255,255,255,0.85)' };
function draw(lm) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * devicePixelRatio) { canvas.width = w * devicePixelRatio; canvas.height = h * devicePixelRatio; }
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!lm) return;
  // object-fit: contain — map normalized video coords onto the letterboxed view.
  const vw = video.videoWidth, vh = video.videoHeight, s = Math.min(w / vw, h / vh);
  const ox = (w - vw * s) / 2, oy = (h - vh * s) / 2;
  const P = (p) => [ox + p.x * vw * s, oy + p.y * vh * s];
  ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.strokeStyle = COLORS[color] || COLORS.white;
  for (const [a, b] of EDGES) {
    if ((lm[a].visibility ?? 1) < 0.5 || (lm[b].visibility ?? 1) < 0.5) continue;
    const [x1, y1] = P(lm[a]), [x2, y2] = P(lm[b]);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  ctx.fillStyle = '#fff';
  for (let i = 11; i < 33; i++) {
    if ((lm[i].visibility ?? 1) < 0.5) continue;
    const [x, y] = P(lm[i]); ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
  }
}

async function start() {
  post({ type: 'status', status: 'loading' });
  let landmarker, delegate = '';
  try {
    const { FilesetResolver, PoseLandmarker } = await import(CFG.bundleUrl);
    const vision = await FilesetResolver.forVisionTasks(CFG.wasmUrl);
    const build = (delegate) => PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: CFG.modelUrl, delegate }, runningMode: 'VIDEO', numPoses: 1,
    });
    try { landmarker = await build('GPU'); delegate = 'GPU'; } catch (_) { landmarker = await build('CPU'); delegate = 'CPU'; }
  } catch (e) {
    post({ type: 'status', status: 'error', detail: 'Could not load body tracking: ' + (e && e.message || e) });
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: CFG.facing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
    video.srcObject = stream;
    await video.play();
  } catch (e) {
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    post({ type: 'status', status: denied ? 'denied' : 'error', detail: 'Camera unavailable: ' + (e && e.message || e) });
    return;
  }
  post({ type: 'status', status: 'ready', detail: 'lite · ' + delegate + ' · ' + video.videoWidth + 'x' + video.videoHeight });
  let lastTime = -1;
  // A detection that throws (no WebGL at all: MediaPipe needs it for its image input even on the
  // CPU) must not look like an empty room: after a second of failures, report the error.
  let failures = 0;
  const loop = () => {
    requestAnimationFrame(loop);
    if (!active || video.readyState < 2 || video.currentTime === lastTime) return;
    lastTime = video.currentTime;
    const now = performance.now();
    let res;
    try {
      res = landmarker.detectForVideo(video, now);
      failures = 0;
    } catch (e) {
      if (++failures === 30) post({ type: 'status', status: 'error', detail: 'Body tracking stopped: ' + (e && e.message || e) });
      return;
    }
    const ms = +(performance.now() - now).toFixed(1);
    if (!res.landmarks || res.landmarks.length === 0) {
      if (++missed > LOST_AFTER) resetFilter();
      draw(null);
      post({ type: 'frame', t: +now.toFixed(1), ms, w: video.videoWidth, h: video.videoHeight, lm: null });
    } else {
      missed = 0;
      const t = now / 1000;
      const raw = res.landmarks[0];
      vis = vis ? raw.map((p, i) => vis[i] + VIS_ALPHA * ((p.visibility ?? 1) - vis[i])) : raw.map((p) => p.visibility ?? 1);
      const lm = raw.map((p, i) => ({ x: fx[i].f(p.x, t), y: fy[i].f(p.y, t), z: fz[i].f(p.z ?? 0, t), visibility: vis[i] }));
      draw(lm);
      const flat = [];
      for (const p of lm) flat.push(+p.x.toFixed(5), +p.y.toFixed(5), +(p.z ?? 0).toFixed(5), +(p.visibility ?? 1).toFixed(3));
      post({ type: 'frame', t: +now.toFixed(1), ms, w: video.videoWidth, h: video.videoHeight, lm: flat });
    }
  };
  requestAnimationFrame(loop);
}
start();
</script>
</body></html>`;
}

/** A page message as the app receives it. */
export type TrackerMessage =
  | { type: 'status'; status: 'loading' | 'ready' | 'denied' | 'error'; detail?: string }
  | { type: 'frame'; t?: number; ms?: number; w: number; h: number; lm: number[] | null };

export function parseTrackerMessage(raw: unknown): TrackerMessage | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const m = value as Partial<TrackerMessage> | null;
  if (!m || typeof m !== 'object') return null;
  if (m.type === 'status' && typeof (m as { status?: unknown }).status === 'string') return m as TrackerMessage;
  if (m.type === 'frame') {
    const f = m as { t?: unknown; ms?: unknown; w?: unknown; h?: unknown; lm?: unknown };
    if (typeof f.w !== 'number' || typeof f.h !== 'number' || f.w <= 0 || f.h <= 0) return null;
    if (f.t !== undefined && (typeof f.t !== 'number' || !Number.isFinite(f.t))) return null;
    if (f.ms !== undefined && (typeof f.ms !== 'number' || !Number.isFinite(f.ms) || f.ms < 0)) return null;
    if (f.lm !== null && !(Array.isArray(f.lm) && f.lm.length === 33 * 4 && f.lm.every((n) => typeof n === 'number'))) return null;
    return m as TrackerMessage;
  }
  return null;
}
