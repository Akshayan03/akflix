$ErrorActionPreference = "Stop"
$installer = Get-ChildItem "src-tauri/target/release/bundle/nsis/*-setup.exe" | Select-Object -First 1
if (!$installer) { throw "No Windows setup executable was produced" }
$installPath = Join-Path $env:RUNNER_TEMP "akflix-install-smoke"
$setup = Start-Process -FilePath $installer.FullName -ArgumentList @("/S", "/D=$installPath") -Wait -PassThru
if ($setup.ExitCode -ne 0) { throw "Installer failed: $($setup.ExitCode)" }

foreach ($name in @("akflix.exe", "rqbit.exe", "ffmpeg.exe")) {
  if (!(Test-Path (Join-Path $installPath $name))) { throw "Installed app is missing $name" }
}

# Run outside MSYS2 to catch missing compiler DLLs in the shipped sidecars.
& (Join-Path $installPath "ffmpeg.exe") -hide_banner -version
if ($LASTEXITCODE -ne 0) { throw "Installed FFmpeg cannot start" }
& (Join-Path $installPath "rqbit.exe") --version
if ($LASTEXITCODE -ne 0) { throw "Installed playback engine cannot start" }

$app = Start-Process -FilePath (Join-Path $installPath "akflix.exe") -PassThru
try {
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Seconds 2
    $app.Refresh()
    if ($app.HasExited) { throw "Akflix exited during startup: $($app.ExitCode)" }
    try {
      $response = Invoke-WebRequest "http://127.0.0.1:3031/torrents" -TimeoutSec 2
      if ($response.StatusCode -eq 200 -and $app.MainWindowHandle -ne 0) {
        $ready = $true
        break
      }
    } catch { Write-Host "Waiting for the app window and bundled playback engine..." }
  }
  if (!$ready) { throw "Installed Akflix did not open a window and start its playback API" }
  Write-Host "PASS: Windows installer, native app window, FFmpeg and playback API."
} finally {
  if (!$app.HasExited) { Stop-Process -Id $app.Id -Force }
  Get-Process rqbit -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Join-Path $installPath "rqbit.exe") } | Stop-Process -Force
}
