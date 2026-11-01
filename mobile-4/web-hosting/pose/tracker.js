// Squirrel Social - Same-Origin Pose Tracker (MediaPipe Tasks Vision)
// Runs inside /pose/tracker.html without inline scripts or CDN dependencies.

const params = new URLSearchParams(window.location.search);
const CFG = {
  facing: params.get('facing') || 'user',
  bundleUrl: params.get('bundleUrl') || '/pose/vision_bundle.mjs',
  wasmUrl: params.get('wasmUrl') || '/pose/wasm',
  modelUrl: params.get('modelUrl') || '/pose/pose_landmarker_lite.task',
};

const post = (m) => {
  const s = JSON.stringify(m);
  if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(s);
  } else if (window.parent && window.parent !== window) {
    window.parent.postMessage(s, '*');
  }
};

const video = document.getElementById('v');
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');

if (CFG.facing === 'user') {
  video.classList.add('mirror');
  canvas.classList.add('mirror');
}

let active = true;
let color = 'white';

const onHost = (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'skeleton') color = msg.color;
  if (msg.type === 'active') active = !!msg.value;
};

window.__host = onHost;
window.addEventListener('message', (e) => {
  try {
    onHost(typeof e.data === 'string' ? JSON.parse(e.data) : e.data);
  } catch (_) {}
});

// One Euro filter, as frontend-react/src/pose/oneEuro.ts (Casiez et al., CHI 2012).
const MIN_CUTOFF = 1.5;
const BETA = 15.0;
const D_CUTOFF = 1.0;

class LowPass {
  constructor() {
    this.has = false;
    this.raw = 0;
    this.y = 0;
  }
  f(x, a) {
    const y = this.has ? a * x + (1 - a) * this.y : x;
    this.has = true;
    this.raw = x;
    this.y = y;
    return y;
  }
  reset() {
    this.has = false;
  }
}

class OneEuro {
  constructor() {
    this.x = new LowPass();
    this.dx = new LowPass();
    this.t = null;
  }
  a(cut, dt) {
    const tau = 1 / (2 * Math.PI * cut);
    return 1 / (1 + tau / dt);
  }
  f(v, t) {
    if (this.t === null) {
      this.t = t;
      return this.x.f(v, 1);
    }
    const dt = Math.max(1e-3, t - this.t);
    this.t = t;
    const d = this.x.has ? (v - this.x.raw) / dt : 0;
    const ed = this.dx.f(d, this.a(D_CUTOFF, dt));
    return this.x.f(v, this.a(MIN_CUTOFF + BETA * Math.abs(ed), dt));
  }
  reset() {
    this.x.reset();
    this.dx.reset();
    this.t = null;
  }
}

const bank = () => Array.from({ length: 33 }, () => new OneEuro());
let fx = bank();
let fy = bank();
let fz = bank();

// Visibility: exponential smoothing both ways
const VIS_ALPHA = 0.4;
let vis = null;
const resetFilter = () => {
  fx.forEach((f) => f.reset());
  fy.forEach((f) => f.reset());
  fz.forEach((f) => f.reset());
  vis = null;
};

// Consecutive frames without a body before smoothing is dropped (~0.25 s at 30 fps)
const LOST_AFTER = 8;
// Consecutive frames without a body before warning about lighting/visibility (~1.0 s at 30 fps)
const NO_BODY_THRESHOLD = 30;
let missed = 0;

const EDGES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24], [23, 25], [25, 27],
  [24, 26], [26, 28], [27, 29], [29, 31], [27, 31],
  [28, 30], [30, 32], [28, 32], [15, 17], [15, 19],
  [15, 21], [16, 18], [16, 20], [16, 22], [0, 11], [0, 12],
];

const COLORS = {
  green: '#3DDC84',
  red: '#FF3B5C',
  white: 'rgba(255,255,255,0.85)',
};

function draw(lm) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== w * devicePixelRatio) {
    canvas.width = w * devicePixelRatio;
    canvas.height = h * devicePixelRatio;
  }
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!lm) return;

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const s = Math.min(w / vw, h / vh);
  const ox = (w - vw * s) / 2;
  const oy = (h - vh * s) / 2;
  const P = (p) => [ox + p.x * vw * s, oy + p.y * vh * s];

  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.strokeStyle = COLORS[color] || COLORS.white;

  for (const [a, b] of EDGES) {
    if ((lm[a].visibility ?? 1) < 0.5 || (lm[b].visibility ?? 1) < 0.5) continue;
    const [x1, y1] = P(lm[a]);
    const [x2, y2] = P(lm[b]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  ctx.fillStyle = '#fff';
  for (let i = 11; i < 33; i++) {
    if ((lm[i].visibility ?? 1) < 0.5) continue;
    const [x, y] = P(lm[i]);
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

async function start() {
  post({ type: 'status', status: 'loading' });

  // 1. Check WebAssembly support
  if (typeof WebAssembly === 'undefined' || typeof WebAssembly.instantiate !== 'function') {
    post({
      type: 'status',
      status: 'error',
      detail: 'WebAssembly is not supported or disabled in this browser. Please use an updated modern browser.',
    });
    return;
  }

  // 2. Check WebGL support
  const testCanvas = document.createElement('canvas');
  const gl = testCanvas.getContext('webgl2') || testCanvas.getContext('webgl') || testCanvas.getContext('experimental-webgl');
  if (!gl) {
    post({
      type: 'status',
      status: 'error',
      detail: 'Hardware graphics acceleration (WebGL) is disabled or unsupported. Please enable hardware acceleration in your browser settings.',
    });
    return;
  }

  // 3. Initialize MediaPipe Tasks Vision
  let landmarker;
  let delegate = '';
  try {
    const { FilesetResolver, PoseLandmarker } = await import(CFG.bundleUrl);
    const vision = await FilesetResolver.forVisionTasks(CFG.wasmUrl);
    const build = (del) =>
      PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: CFG.modelUrl, delegate: del },
        runningMode: 'VIDEO',
        numPoses: 1,
      });

    try {
      landmarker = await build('GPU');
      delegate = 'GPU';
    } catch (_) {
      landmarker = await build('CPU');
      delegate = 'CPU';
    }
  } catch (e) {
    post({
      type: 'status',
      status: 'error',
      detail: 'Could not load body tracking model: ' + (e && e.message ? e.message : String(e)),
    });
    return;
  }

  // 4. Request camera access
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    post({
      type: 'status',
      status: 'error',
      detail: 'Camera API (getUserMedia) is unavailable. Please ensure you are browsing over HTTPS.',
    });
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: CFG.facing, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
  } catch (e) {
    const name = e && e.name ? e.name : '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      post({
        type: 'status',
        status: 'denied',
        detail: 'Camera permission was denied in your browser. Click the camera icon in your address bar to allow access, then tap Try again.',
      });
    } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      post({
        type: 'status',
        status: 'no_camera',
        detail: 'No camera found on this device. Please connect a webcam or switch to a device with a camera.',
      });
    } else if (name === 'NotReadableError' || name === 'TrackStartError') {
      post({
        type: 'status',
        status: 'error',
        detail: 'Camera is currently in use by another application or tab.',
      });
    } else {
      post({
        type: 'status',
        status: 'error',
        detail: 'Camera unavailable: ' + (e && e.message ? e.message : String(e)),
      });
    }
    return;
  }

  post({
    type: 'status',
    status: 'ready',
    detail: 'lite · ' + delegate + ' · ' + video.videoWidth + 'x' + video.videoHeight,
  });

  let lastTime = -1;
  let failures = 0;

  const loop = () => {
    requestAnimationFrame(loop);
    if (!active || video.readyState < 2 || video.currentTime === lastTime) return;
    if (document.visibilityState === 'hidden') return;

    lastTime = video.currentTime;
    const now = performance.now();
    let res;

    try {
      res = landmarker.detectForVideo(video, now);
      failures = 0;
    } catch (e) {
      if (++failures === 30) {
        post({
          type: 'status',
          status: 'error',
          detail: 'Body tracking stopped: ' + (e && e.message ? e.message : String(e)),
        });
      }
      return;
    }

    const ms = +(performance.now() - now).toFixed(1);

    if (!res.landmarks || res.landmarks.length === 0) {
      missed++;
      if (missed > LOST_AFTER) resetFilter();
      draw(null);
      post({
        type: 'frame',
        t: +now.toFixed(1),
        ms,
        w: video.videoWidth,
        h: video.videoHeight,
        lm: null,
        warning: missed > NO_BODY_THRESHOLD ? 'no_body' : undefined,
      });
    } else {
      missed = 0;
      const t = now / 1000;
      const raw = res.landmarks[0];
      vis = vis
        ? raw.map((p, i) => vis[i] + VIS_ALPHA * ((p.visibility ?? 1) - vis[i]))
        : raw.map((p) => p.visibility ?? 1);
      const lm = raw.map((p, i) => ({
        x: fx[i].f(p.x, t),
        y: fy[i].f(p.y, t),
        z: fz[i].f(p.z ?? 0, t),
        visibility: vis[i],
      }));

      draw(lm);

      const flat = [];
      for (const p of lm) {
        flat.push(+p.x.toFixed(5), +p.y.toFixed(5), +(p.z ?? 0).toFixed(5), +(p.visibility ?? 1).toFixed(3));
      }

      post({
        type: 'frame',
        t: +now.toFixed(1),
        ms,
        w: video.videoWidth,
        h: video.videoHeight,
        lm: flat,
      });
    }
  };

  requestAnimationFrame(loop);
}

start();
