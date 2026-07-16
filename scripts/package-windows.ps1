[CmdletBinding()]
param(
  [string]$Version = "",
  [string]$BunExe = "",
  [switch]$ChecksumOnly
)

$ErrorActionPreference = "Stop"
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$dist = [IO.Path]::GetFullPath((Join-Path $root "dist"))
$rootPrefix = $root.TrimEnd("\") + "\"
$distPrefix = $dist.TrimEnd("\") + "\"

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
    $stream.Dispose()
  }
}

if (-not $dist.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to package outside the project: $dist"
}

if (-not $Version) {
  $Version = (Get-Content -Raw (Join-Path $root "package.json") | ConvertFrom-Json).version
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  throw "Version must use x.y.z format: $Version"
}

if (-not $BunExe) {
  $bunCommand = Get-Command bun.exe -ErrorAction SilentlyContinue
  if (-not $bunCommand) { throw "bun.exe was not found. Pass -BunExe with an absolute path." }
  $BunExe = $bunCommand.Source
}
$BunExe = [IO.Path]::GetFullPath($BunExe)
if (-not (Test-Path -LiteralPath $BunExe -PathType Leaf)) { throw "bun.exe does not exist: $BunExe" }

$packageName = "Mixin-ClawLink-v$Version-windows-x64"
$packageDir = [IO.Path]::GetFullPath((Join-Path $dist $packageName))
$zipPath = [IO.Path]::GetFullPath((Join-Path $dist "$packageName.zip"))
$checksumPath = "$zipPath.sha256"
$tempDir = [IO.Path]::GetFullPath((Join-Path $dist ".pack-temp"))

foreach ($target in @($packageDir, $zipPath, $checksumPath, $tempDir)) {
  if (-not $target.StartsWith($distPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to replace a path outside dist: $target"
  }
}

if ($ChecksumOnly) {
  if (-not (Test-Path -LiteralPath $zipPath -PathType Leaf)) { throw "ZIP does not exist: $zipPath" }
  $hash = Get-Sha256 $zipPath
  [IO.File]::WriteAllText($checksumPath, "$hash  $([IO.Path]::GetFileName($zipPath))`r`n", [Text.UTF8Encoding]::new($false))
  Write-Host "ZIP:      $zipPath"
  Write-Host "SHA-256:  $hash"
  return
}

New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path -LiteralPath $packageDir) { Remove-Item -LiteralPath $packageDir -Recurse -Force }
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
if (Test-Path -LiteralPath $checksumPath) { Remove-Item -LiteralPath $checksumPath -Force }
if (Test-Path -LiteralPath $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force }

New-Item -ItemType Directory -Force -Path $packageDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $packageDir "runtime") | Out-Null
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
Copy-Item -LiteralPath (Join-Path $root "src") -Destination (Join-Path $packageDir "src") -Recurse
foreach ($file in @("package.json", "bun.lock", "bunfig.toml", "README.md")) {
  Copy-Item -LiteralPath (Join-Path $root $file) -Destination (Join-Path $packageDir $file)
}
Copy-Item -LiteralPath (Join-Path $root "packaging\windows\start.cmd") -Destination (Join-Path $packageDir "start.cmd")
Copy-Item -LiteralPath (Join-Path $root "packaging\windows\README-WINDOWS.md") -Destination (Join-Path $packageDir "README-WINDOWS.md")
Copy-Item -LiteralPath (Join-Path $root "packaging\windows\BUN-LICENSE.md") -Destination (Join-Path $packageDir "BUN-LICENSE.md")
Copy-Item -LiteralPath $BunExe -Destination (Join-Path $packageDir "runtime\bun.exe")

$launcherSource = Join-Path $root "packaging\windows\Launcher.cs"
$launcherExe = Join-Path $packageDir "MixinClawLink.exe"
$launcherIcon = Join-Path $root "assets\icons\mixin-clawlink.ico"
if (-not (Test-Path -LiteralPath $launcherIcon -PathType Leaf)) { throw "Missing Windows application icon: $launcherIcon" }
Add-Type -Path $launcherSource -OutputAssembly $launcherExe -OutputType ConsoleApplication -CompilerOptions "/win32icon:`"$launcherIcon`"" -ReferencedAssemblies @("System.dll", "System.Drawing.dll", "System.Windows.Forms.dll")
if (-not (Test-Path -LiteralPath $launcherExe -PathType Leaf)) { throw "Windows launcher compilation failed" }

Push-Location $packageDir
$oldTemp = $env:TEMP
$oldTmp = $env:TMP
$oldBunCache = $env:BUN_INSTALL_CACHE_DIR
try {
  $env:TEMP = $tempDir
  $env:TMP = $tempDir
  $env:BUN_INSTALL_CACHE_DIR = (Join-Path $tempDir "bun-cache")
  & ".\runtime\bun.exe" install --production --frozen-lockfile --ignore-scripts --omit=optional
  if ($LASTEXITCODE -ne 0) { throw "Production dependency installation failed with exit code $LASTEXITCODE" }
  $openTuiNativeSource = Join-Path $root "node_modules\@opentui\core-win32-x64"
  $openTuiNativeTarget = Join-Path $packageDir "node_modules\@opentui\core-win32-x64"
  if (-not (Test-Path -LiteralPath $openTuiNativeSource -PathType Container)) { throw "Missing OpenTUI win32-x64 native package" }
  New-Item -ItemType Directory -Force -Path (Split-Path $openTuiNativeTarget -Parent) | Out-Null
  Copy-Item -LiteralPath $openTuiNativeSource -Destination $openTuiNativeTarget -Recurse
  if (Test-Path -LiteralPath (Join-Path $packageDir "node_modules\@anthropic-ai\claude-agent-sdk-win32-x64")) {
    throw "Bundled Claude CLI must not be present in the one-dir package"
  }
  & ".\runtime\bun.exe" -e "await import('./src/tui/index.tsx'); console.log('Runtime import OK')"
  if ($LASTEXITCODE -ne 0) { throw "Packaged runtime smoke test failed with exit code $LASTEXITCODE" }
} finally {
  $env:TEMP = $oldTemp
  $env:TMP = $oldTmp
  $env:BUN_INSTALL_CACHE_DIR = $oldBunCache
  Pop-Location
  if (Test-Path -LiteralPath $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force }
}

Compress-Archive -LiteralPath $packageDir -DestinationPath $zipPath -CompressionLevel Optimal
$hash = Get-Sha256 $zipPath
[IO.File]::WriteAllText($checksumPath, "$hash  $([IO.Path]::GetFileName($zipPath))`r`n", [Text.UTF8Encoding]::new($false))

Write-Host "Package:  $packageDir"
Write-Host "ZIP:      $zipPath"
Write-Host "SHA-256:  $hash"
