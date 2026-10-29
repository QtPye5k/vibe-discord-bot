param([ValidateSet('setup','start','check')][string]$Action = 'start')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$bundledRoot = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies'
if (Test-Path -LiteralPath $bundledRoot) {
  $env:PATH = (Join-Path $bundledRoot 'node\bin') + ';' + (Join-Path $bundledRoot 'bin\fallback') + ';' + $env:PATH
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 24.17 or later in the 24.x release series.' }
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw 'Install pnpm 11.25.0: npm install -g pnpm@11.25.0' }
if ($Action -eq 'setup') {
  foreach ($binary in @('ffmpeg', 'ffprobe')) {
    if (-not (Get-Command $binary -ErrorAction SilentlyContinue)) {
      throw "Install FFmpeg, including ffmpeg and ffprobe on PATH, before running SETUP.cmd. Download: https://ffmpeg.org/download.html (missing $binary)."
    }
    & $binary -version *> $null
    if ($LASTEXITCODE -ne 0) { throw "$binary did not run successfully. Repair the FFmpeg installation before setup." }
  }
  & pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
  & pnpm configure
  if ($LASTEXITCODE -ne 0) { throw 'Optional configuration preparation failed.' }
  & pnpm check
  if ($LASTEXITCODE -ne 0) { throw 'Verification failed.' }
  & pnpm voice:prepare
  if ($LASTEXITCODE -ne 0) { throw 'Local voice model preparation failed. Check network access/model availability, then run pnpm voice:prepare again.' }
  if (-not (Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
  Write-Host 'Setup complete. Fill the two credentials in .env, then run CHECK.cmd and START.cmd.'
} elseif ($Action -eq 'check') {
  & pnpm run doctor
} else {
  if (-not (Test-Path -LiteralPath 'dist\main.js')) { throw 'Run SETUP.cmd first.' }
  & pnpm start
}
exit $LASTEXITCODE
