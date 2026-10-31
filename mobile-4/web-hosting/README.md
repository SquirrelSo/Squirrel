# Squirrel Social Web Production Hosting

Production hosting configuration and deployment guide for `https://www.squirrelsocial.life`.

---

## 1. Single Page Application (SPA) & Security Architecture

### Routing
`vercel.json` enforces SPA catch-all rewrites:
```json
{ "source": "/(.*)", "destination": "/index.html" }
```
This guarantees deep client-side routes (e.g. `/explore`, `/sign-in`, `/post/:id`, `/date`, `/partner-hunt`) resolve to `/index.html` on direct browser navigation without HTTP 404s.
Do not add `"cleanUrls"` or `"trailingSlash"` back to `vercel.json`: they break Vercel's SPA catch-all rewrite, causing direct navigation to client routes (like `/profile` and `/social`) to return 404.

### Content Security Policy (CSP)
- **`connect-src`**: Strictly pinned to the active Railway services, Supabase storage, and local origins:
  - Exercise Backend: `https://squirrel-exercise-production.up.railway.app`
  - Run Module: `https://squirrel-run-api-production.up.railway.app`
  - Social Service: `https://squirrel-social-production.up.railway.app`
  - Campus Service: `https://squirrel-campus-production.up.railway.app`
  - Realtime WebSocket: `wss://squirrel-campus-production.up.railway.app`
  - Supabase Storage: `https://egtooqnjepgsmirnqgsj.supabase.co`
  - Local origins: `'self'`, `blob:`, `data:` (required for photo uploads and canvas blobs).
- **Inline Code Justification**:
  - `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`: Required because `react-native-web` dynamically generates and injects atomic CSS style elements (`<style>`) into the DOM at runtime.
  - `script-src 'self' 'wasm-unsafe-eval'`: Production bundle scripts are loaded exclusively from external bundle files (`/_expo/static/js/web/entry-*.js`). Inline scripts (`'unsafe-inline'`) are disallowed. `'wasm-unsafe-eval'` is reserved for WebAssembly instantiation.

---

## 2. Phase (a) Build & Export

### Windows PowerShell 5.1 (Standard Windows Shell)

Run from the `mobile-4` directory:

```powershell
# Set production environment variables
$env:EXPO_PUBLIC_API_URL = "https://squirrel-run-api-production.up.railway.app"
$env:EXPO_PUBLIC_EXERCISE_API_URL = "https://squirrel-exercise-production.up.railway.app"
$env:EXPO_PUBLIC_AUTH_URL = "https://squirrel-exercise-production.up.railway.app"
$env:EXPO_PUBLIC_SOCIAL_API_URL = "https://squirrel-social-production.up.railway.app"
$env:EXPO_PUBLIC_CAMPUS_SERVICE_URL = "https://squirrel-campus-production.up.railway.app"
$env:EXPO_PUBLIC_REALTIME_URL = "wss://squirrel-campus-production.up.railway.app/v1/realtime"
$env:EXPO_PUBLIC_DEV_MOCKS = "0"
$env:EXPO_NO_TELEMETRY = "1"

# Export web production bundle
npx expo export -p web --clear
```

### Linux / macOS Bash

Run from the `mobile-4` directory:

```bash
# Set production environment variables
export EXPO_PUBLIC_API_URL="https://squirrel-run-api-production.up.railway.app"
export EXPO_PUBLIC_EXERCISE_API_URL="https://squirrel-exercise-production.up.railway.app"
export EXPO_PUBLIC_AUTH_URL="https://squirrel-exercise-production.up.railway.app"
export EXPO_PUBLIC_SOCIAL_API_URL="https://squirrel-social-production.up.railway.app"
export EXPO_PUBLIC_CAMPUS_SERVICE_URL="https://squirrel-campus-production.up.railway.app"
export EXPO_PUBLIC_REALTIME_URL="wss://squirrel-campus-production.up.railway.app/v1/realtime"
export EXPO_PUBLIC_DEV_MOCKS="0"
export EXPO_NO_TELEMETRY="1"

# Export web production bundle
npx expo export -p web --clear
```

---

## 3. Isolated Deployment via Vercel CLI (Outside the Repository)

To keep the repository clean and ensure `npx expo export --clear` never wipes your `.vercel` link credentials, deployment runs from an isolated folder outside the repo (`C:\Users\ASUS\web-deploy`).

### Why `prepare-deploy.ps1` is Required (Vercel Skips `node_modules`)

When Expo exports web assets (`npx expo export -p web`), bundled assets originating from npm packages (such as `@expo/vector-icons`, `@expo-google-fonts/*`, and `expo-router`) are emitted into `dist/assets/node_modules/...`.

During deployment, **Vercel's CLI and deployment pipeline automatically ignore and drop any folder named `node_modules`** (treating it as build dependency scratch rather than static output). As a result, all font files, icon glyphs, and navigation assets inside `dist/assets/node_modules` return HTTP 404 when hosted on Vercel.

The [`prepare-deploy.ps1`](./prepare-deploy.ps1) script automates this preparation:
1. **Relocates assets**: Renames `dist/assets/node_modules` to `dist/assets/vendor`.
2. **Rewrites bundle paths**: Patches every `.js`, `.html`, and `.json` file in `dist` to replace `"assets/node_modules"` with `"assets/vendor"` using UTF-8 without BOM.
3. **Isolates external deploy target**: Clears `C:\Users\ASUS\web-deploy` while preserving `.vercel` credentials.
4. **Stages build artifacts**: Copies `dist/*` and `web-hosting/vercel.json` into `C:\Users\ASUS\web-deploy`.
5. **Asserts compliance**: Verifies that 0 references to `assets/node_modules` remain in the deployment bundle.

> [!CAUTION]
> **CRITICAL PROJECT WARNING**:
> - **NEVER** run deployment from `mobile-4/` or `dist/`.
> - **NEVER** link to `squirrel-amber-sigma-virid` or `sqso_webapp`. That project hosts the static invite landing page and APK distribution route. Linking to it will overwrite the invite page.
> - **NEVER** run `vercel link --yes` bare without specifying `--project squirrel-social-web`.

### Step 1: Prepare the External Deployment Folder

From `mobile-4/`:

#### Windows PowerShell 5.1
```powershell
.\web-hosting\prepare-deploy.ps1
```

*(On Linux / macOS Bash)*:
```bash
# 1. Rename node_modules assets to vendor
if [ -d "dist/assets/node_modules" ]; then
  rm -rf dist/assets/vendor
  mv dist/assets/node_modules dist/assets/vendor
fi

# 2. Patch references in bundle files
find dist -type f \( -name "*.js" -o -name "*.html" -o -name "*.json" \) -exec sed -i 's|assets/node_modules|assets/vendor|g' {} +

# 3. Clear deploy directory preserving .vercel
mkdir -p ~/web-deploy
find ~/web-deploy -mindepth 1 -not -name '.vercel*' -delete

# 4. Copy dist contents and vercel.json
cp -r dist/* ~/web-deploy/
cp web-hosting/vercel.json ~/web-deploy/vercel.json

# 5. Assert no remaining references
if grep -r "assets/node_modules" ~/web-deploy/; then
  echo "Error: assets/node_modules still referenced!" >&2; exit 1
fi
```

### Step 2: Link the Project (One-Time Setup in `web-deploy`)
Switch into `C:\Users\ASUS\web-deploy`:
```powershell
Set-Location "C:\Users\ASUS\web-deploy"

vercel link --yes --project squirrel-social-web
```

**Verification Step**: Check the terminal output immediately after linking. Confirm that:
1. The **Team Scope** matches your intended Vercel account / organization.
2. The **Project Name** is strictly `squirrel-social-web`.

### Step 3: Deploy to Production
From `C:\Users\ASUS\web-deploy`:
```powershell
vercel deploy --prod --yes
```

For non-interactive CI/CD deployment with a token:
```powershell
vercel deploy --prod --yes --token "$env:VERCEL_TOKEN"
```

---

## 4. Phase (c) Only: Self-Hosting Pose Assets

> [!NOTE]
> Do NOT set `EXPO_PUBLIC_POSE_ASSETS_URL` during Phase (a) or Phase (b). Pose coach assets are only needed when shipping the browser-native camera coach in Phase (c).

When Phase (c) is activated, download MediaPipe Tasks Vision (v0.10.35) into `dist/pose/` before copying to `web-deploy`:

### Windows PowerShell 5.1
```powershell
New-Item -ItemType Directory -Force -Path dist/pose/wasm

Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs" -OutFile "dist/pose/vision_bundle.mjs"
Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm/vision_wasm_internal.js" -OutFile "dist/pose/wasm/vision_wasm_internal.js"
Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm/vision_wasm_internal.wasm" -OutFile "dist/pose/wasm/vision_wasm_internal.wasm"
Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm/vision_wasm_nosimd_internal.js" -OutFile "dist/pose/wasm/vision_wasm_nosimd_internal.js"
Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm/vision_wasm_nosimd_internal.wasm" -OutFile "dist/pose/wasm/vision_wasm_nosimd_internal.wasm"
Invoke-WebRequest -Uri "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task" -OutFile "dist/pose/pose_landmarker_lite.task"
```

### Linux / macOS Bash
```bash
mkdir -p dist/pose/wasm

curl -sSL "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs" -o dist/pose/vision_bundle.mjs
curl -sSL "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm/vision_wasm_internal.js" -o dist/pose/wasm/vision_wasm_internal.js
curl -sSL "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm/vision_wasm_internal.wasm" -o dist/pose/wasm/vision_wasm_internal.wasm
curl -sSL "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm/vision_wasm_nosimd_internal.js" -o dist/pose/wasm/vision_wasm_nosimd_internal.js
curl -sSL "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm/vision_wasm_nosimd_internal.wasm" -o dist/pose/wasm/vision_wasm_nosimd_internal.wasm
curl -sSL "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task" -o dist/pose/pose_landmarker_lite.task
```

For Phase (c) builds only, add:
- PowerShell: `$env:EXPO_PUBLIC_POSE_ASSETS_URL = "/pose"`
- Bash: `export EXPO_PUBLIC_POSE_ASSETS_URL="/pose"`

---

## 5. Manual Test Plan: Real GPS Runs on Web (Chrome DevTools Sensors)

Use Chrome DevTools to verify browser-native GPS tracking, permissions, wake lock, tab visibility warnings, and upload handling.

### Prerequisites & Setup
1. Open the hosted web app (`https://www.squirrelsocial.life`) or local web export in Google Chrome.
2. Open DevTools (`F12` or `Ctrl+Shift+I` on Windows/Linux; `Cmd+Option+I` on macOS).
3. Press `Esc` to open the drawer panel, click **More tools** (`⋮`), and select **Sensors**.

### Test Case 1: Geolocation Permission Flow & Demo Route
1. In site settings (lock icon in URL bar), set **Location** to **Ask** or **Block**.
2. Navigate to **Start a run** from Home, Create sheet, or `/run`.
3. If blocked/denied:
   - Confirm the banner displays **Location permission denied** with browser instructions.
   - Confirm **Try demo route (simulated)** is available and starts the non-counted simulation.
4. Set Location to **Allow** and tap **Ask again**:
   - Confirm status transitions to **GPS · searching** / **GPS · ±X m**.
   - Confirm **Start Run** and **Start Walk** buttons become active.

### Test Case 2: Live Movement Emulation
1. In the **Sensors** drawer under **Location**, select **Custom location** (e.g. Latitude `22.9550`, Longitude `88.5450`).
2. Tap **Start Run** and wait for the 3.. 2.. 1.. countdown.
3. Confirm the foreground reminder appears:
   > *"Keep this tab open and in front. Web GPS pauses if the tab is hidden or minimized."*
4. Simulate movement by updating latitude every 2–3 seconds (e.g. `22.9552`, `22.9555`, `22.9558`).
5. Confirm distance (KM) increments, moving pace calculates, and points draw on the map.

### Test Case 3: Tab Backgrounding & Screen Wake Lock
1. While the run is active, open a new browser tab or minimize Chrome.
2. Wait 5 seconds, then switch back to the Squirrel tab.
3. Confirm the background warning banner appears:
   > *"Tab was backgrounded. Tracking may pause or drop points when the tab is hidden — keep Squirrel in front."*
4. Confirm tracking resumes and Screen Wake Lock is re-engaged.

### Test Case 4: Network Disconnection & Recovery
1. In DevTools **Network** tab, switch throttling to **Offline**.
2. Confirm the offline banner displays:
   > *"You appear to be offline. Your route is tracked locally and will upload when connection is restored."*
3. Switch throttling back to **No throttling** (Online).
4. Long-press to finish the run; confirm points upload to the Run Module with their idempotency key and zones are verified.

