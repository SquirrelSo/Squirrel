# prepare-deploy.ps1 - Windows PowerShell 5.1
# Prepares the web export for Vercel deployment by relocating node_modules assets
# and staging build artifacts into an isolated external directory.

[CmdletBinding()]
param(
    [string]$DeployDir = "C:\Users\ASUS\web-deploy"
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
# (b) Clear C:\Users\ASUS\web-deploy except .vercel
# ---------------------------------------------------------------------------
if (-not (Test-Path $DeployDir)) {
    Write-Host "Creating deployment directory: $DeployDir..."
    New-Item -ItemType Directory -Force -Path $DeployDir | Out-Null
} else {
    Write-Host "Clearing $DeployDir (preserving .vercel credentials)..."
    Get-ChildItem -Path $DeployDir -Force | Where-Object { $_.Name -ne '.vercel' } | Remove-Item -Recurse -Force
}

# ---------------------------------------------------------------------------
# (c) Copy dist contents and web-hosting/vercel.json into C:\Users\ASUS\web-deploy
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
# (d) Assert nothing still references assets/node_modules
# ---------------------------------------------------------------------------
Write-Host "Asserting no remaining references to assets/node_modules in $DeployDir..."

$badNodeModulesDir = Join-Path $DeployDir "assets\node_modules"
if (Test-Path $badNodeModulesDir) {
    Write-Error "Assertion failed: Directory '$badNodeModulesDir' still exists in deploy target!"
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

Write-Host "SUCCESS: Deployment folder '$DeployDir' is prepared and verified (0 references to assets/node_modules)." -ForegroundColor Green
