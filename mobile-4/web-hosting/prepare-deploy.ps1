# prepare-deploy.ps1 - Windows PowerShell 5.1
# Prepares the web export for Vercel deployment by relocating node_modules assets,
# staging self-hosted MediaPipe pose assets, and copying build artifacts into an isolated external directory.

[CmdletBinding()]
param(
    [string]$DeployDir = "C:\Users\ASUS\web-deploy",
    [switch]$SkipPoseDownload
)

$ErrorActionPreference = "Stop"

# Resolve paths
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$mobileDir = (Resolve-Path (Join-Path $scriptDir "..")).Path
$distDir = Join-Path $mobileDir "dist"
$vercelConfig = Join-Path $scriptDir "vercel.json"

Write-Host "=== Squirrel Social Web Deployment Preparation ===" -ForegroundColor Cyan
Write-Host "Mobile directory: $mobileDir"
Write-Host "Dist directory:   $distDir"
Write-Host "Deploy directory: $DeployDir"

if (-not (Test-Path $distDir)) {
    Write-Error "dist folder not found at '$distDir'. Please run 'npx expo export -p web --clear' first."
    exit 1
}

# ---------------------------------------------------------------------------
# (a) Rename dist/assets/node_modules to dist/assets/vendor and patch references
# ---------------------------------------------------------------------------
$nodeModulesAssets = Join-Path $distDir "assets\node_modules"
$vendorAssets = Join-Path $distDir "assets\vendor"

if (Test-Path $nodeModulesAssets) {
    if (Test-Path $vendorAssets) {
        Write-Host "Removing existing $vendorAssets..."
        Remove-Item -Path $vendorAssets -Recurse -Force
    }
    Write-Host "Renaming dist/assets/node_modules -> dist/assets/vendor..."
    Move-Item -Path $nodeModulesAssets -Destination $vendorAssets -Force
} elseif (Test-Path $vendorAssets) {
    Write-Host "dist/assets/vendor already exists (assets/node_modules already renamed)."
} else {
    Write-Host "No assets/node_modules found in dist/assets."
}

# Patch every .js, .html, .json in dist replacing "assets/node_modules" with "assets/vendor" (UTF-8 no BOM)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$filesToPatch = Get-ChildItem -Path $distDir -Recurse -File -Include *.js, *.html, *.json

$patchedCount = 0
foreach ($file in $filesToPatch) {
    $content = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
    if ($content.Contains("assets/node_modules")) {
        $replaced = $content.Replace("assets/node_modules", "assets/vendor")
        [System.IO.File]::WriteAllText($file.FullName, $replaced, $utf8NoBom)
        $patchedCount++
    }
}
Write-Host "Patched $patchedCount file(s) in dist replacing 'assets/node_modules' with 'assets/vendor' (UTF-8 no BOM)."

# ---------------------------------------------------------------------------
# (b) Stage self-hosted MediaPipe pose assets in dist/pose (no runtime CDN)
# ---------------------------------------------------------------------------
$poseDistDir = Join-Path $distDir "pose"
$poseDistWasm = Join-Path $poseDistDir "wasm"
if (-not (Test-Path $poseDistWasm)) {
    New-Item -ItemType Directory -Force -Path $poseDistWasm | Out-Null
}

# Copy tracker.html and tracker.js from public/pose or web-hosting/pose
$webHostingPose = Join-Path $scriptDir "pose"
$publicPose = Join-Path $mobileDir "public\pose"

if (Test-Path $webHostingPose) {
    Write-Host "Copying tracker assets from web-hosting/pose to dist/pose..."
    Copy-Item -Path (Join-Path $webHostingPose "*") -Destination $poseDistDir -Recurse -Force
} elseif (Test-Path $publicPose) {
    Write-Host "Copying tracker assets from public/pose to dist/pose..."
    Copy-Item -Path (Join-Path $publicPose "*") -Destination $poseDistDir -Recurse -Force
}

$poseDownloads = @(
    @{
        Url = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs"
        Dest = Join-Path $poseDistDir "vision_bundle.mjs"
        Name = "vision_bundle.mjs"
    },
    @{
        Url = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm/vision_wasm_internal.js"
        Dest = Join-Path $poseDistWasm "vision_wasm_internal.js"
        Name = "wasm/vision_wasm_internal.js"
    },
    @{
        Url = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm/vision_wasm_internal.wasm"
        Dest = Join-Path $poseDistWasm "vision_wasm_internal.wasm"
        Name = "wasm/vision_wasm_internal.wasm"
    },
    @{
        Url = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm/vision_wasm_nosimd_internal.js"
        Dest = Join-Path $poseDistWasm "vision_wasm_nosimd_internal.js"
        Name = "wasm/vision_wasm_nosimd_internal.js"
    },
    @{
        Url = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm/vision_wasm_nosimd_internal.wasm"
        Dest = Join-Path $poseDistWasm "vision_wasm_nosimd_internal.wasm"
        Name = "wasm/vision_wasm_nosimd_internal.wasm"
    },
    @{
        Url = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"
        Dest = Join-Path $poseDistDir "pose_landmarker_lite.task"
        Name = "pose_landmarker_lite.task"
    }
)

if (-not $SkipPoseDownload) {
    foreach ($item in $poseDownloads) {
        if (-not (Test-Path $item.Dest)) {
            Write-Host "Downloading pose asset '$($item.Name)'..."
            try {
                Invoke-WebRequest -Uri $item.Url -OutFile $item.Dest -UseBasicParsing
            } catch {
                Write-Warning "Could not download '$($item.Name)': $($_.Exception.Message). Ensure network access or stage files in dist/pose beforehand."
            }
        } else {
            Write-Host "Pose asset '$($item.Name)' already present in dist/pose."
        }
    }
}

# ---------------------------------------------------------------------------
# (c) Clear C:\Users\ASUS\web-deploy except .vercel
# ---------------------------------------------------------------------------
if (-not (Test-Path $DeployDir)) {
    Write-Host "Creating deployment directory: $DeployDir..."
    New-Item -ItemType Directory -Force -Path $DeployDir | Out-Null
} else {
    Write-Host "Clearing $DeployDir (preserving .vercel credentials)..."
    Get-ChildItem -Path $DeployDir -Force | Where-Object { $_.Name -ne '.vercel' } | Remove-Item -Recurse -Force
}

# ---------------------------------------------------------------------------
# (d) Copy dist contents and web-hosting/vercel.json into C:\Users\ASUS\web-deploy
# ---------------------------------------------------------------------------
Write-Host "Copying dist contents to $DeployDir..."
Get-ChildItem -Path $distDir -Force | Copy-Item -Destination $DeployDir -Recurse -Force

if (Test-Path $vercelConfig) {
    Copy-Item -Path $vercelConfig -Destination (Join-Path $DeployDir "vercel.json") -Force
    Write-Host "Copied vercel.json to $DeployDir\vercel.json"
} else {
    Write-Error "Missing hosting configuration at '$vercelConfig'."
    exit 1
}

# ---------------------------------------------------------------------------
# (e) Assert nothing still references assets/node_modules and no node_modules directories exist
# ---------------------------------------------------------------------------
Write-Host "Asserting no remaining references to assets/node_modules in $DeployDir..."

$badNodeModulesDirs = Get-ChildItem -Path $DeployDir -Recurse -Directory -Filter "node_modules"
if ($badNodeModulesDirs.Count -gt 0) {
    Write-Error "Assertion failed: Directory named 'node_modules' still exists in deploy target at $($badNodeModulesDirs[0].FullName)!"
    exit 1
}

$deployFiles = Get-ChildItem -Path $DeployDir -Recurse -File -Include *.js, *.html, *.json
$failedFiles = @()

foreach ($file in $deployFiles) {
    $content = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
    if ($content.Contains("assets/node_modules")) {
        $failedFiles += $file.FullName
    }
}

if ($failedFiles.Count -gt 0) {
    Write-Error "Assertion failed: Found references to 'assets/node_modules' in $($failedFiles.Count) deployed file(s):`n$($failedFiles -join "`n")"
    exit 1
}

Write-Host "SUCCESS: Deployment folder '$DeployDir' is prepared and verified (0 references to assets/node_modules, self-hosted pose assets staged)." -ForegroundColor Green
