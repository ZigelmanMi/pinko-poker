# start.ps1 — запуск pin-pok.
# Сервер зрения уходит в фон, окно консоли закрывается.
# Страница расширений открывается только в первый раз.

param(
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONPYCACHEPREFIX = Join-Path $env:TEMP 'pin-pok-pyc'

$ReadyFlag = Join-Path $PSScriptRoot '.pin-pok-ready'

function Find-SystemPython {
  foreach ($candidate in @('py', 'python', 'python3')) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  return $null
}

function Find-Chrome {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  return $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}

function Test-Vision {
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 2
    return [bool]$health.ok
  } catch {
    return $false
  }
}

function Start-VisionHidden {
  if (Test-Vision) { return $true }

  $logDir = Join-Path $PSScriptRoot 'logs'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $outLog = Join-Path $logDir 'vision.out.log'
  $errLog = Join-Path $logDir 'vision.err.log'
  Remove-Item $outLog, $errLog -ErrorAction SilentlyContinue

  Start-Process -FilePath $script:VenvPy `
    -ArgumentList 'vision_server.py' `
    -WorkingDirectory $PSScriptRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog | Out-Null

  for ($i = 0; $i -lt 60; $i++) {
    if (Test-Vision) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

$script:VenvPy = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path $script:VenvPy)) {
  $sys = Find-SystemPython
  if (-not $sys) {
    Write-Host "Python не найден в PATH." -ForegroundColor Red
    Write-Host "Установите Python 3.10+ с галкой Add python.exe to PATH:"
    Write-Host "https://www.python.org/downloads/"
    exit 1
  }
  Write-Host "Создаю .venv" -ForegroundColor Cyan
  & $sys -m venv (Join-Path $PSScriptRoot '.venv')
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $script:VenvPy)) {
    Write-Host "Не удалось создать .venv." -ForegroundColor Red
    exit 1
  }
}

& $script:VenvPy -c "import PIL, numpy, cv2" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Ставлю зависимости..." -ForegroundColor Cyan
  & $script:VenvPy -m pip install -r (Join-Path $PSScriptRoot 'requirements.txt')
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Установка зависимостей не удалась." -ForegroundColor Red
    exit 1
  }
}

& $script:VenvPy (Join-Path $PSScriptRoot 'tools\pack_extension.py')
if ($LASTEXITCODE -ne 0) { exit 1 }
& $script:VenvPy (Join-Path $PSScriptRoot 'tools\preflight.py') 'extension'
if ($LASTEXITCODE -ne 0) { exit 1 }

$firstRun = -not (Test-Path $ReadyFlag)
if ($firstRun -and -not $NoBrowser) {
  $chrome = Find-Chrome
  $ext = Join-Path $PSScriptRoot 'extension'
  if ($chrome) {
    Start-Process -FilePath $chrome -ArgumentList 'chrome://extensions'
  } else {
    Write-Host "Chrome не найден. Откройте chrome://extensions вручную." -ForegroundColor Yellow
  }
  Start-Process explorer.exe -ArgumentList $ext
  Write-Host ""
  Write-Host "Первый запуск. В Chrome один раз:" -ForegroundColor Green
  Write-Host "  1. Режим разработчика"
  Write-Host "  2. Загрузить распакованное"
  Write-Host "  3. Папка extension (она уже открыта)"
  Write-Host ""
  Write-Host "Дальше это окно само закрывается. Сервер работает в фоне."
  Write-Host "Остановка: stop.bat"
  Write-Host ""
}

if (-not (Start-VisionHidden)) {
  Write-Host "Сервер зрения не поднялся. Лог: logs\vision.err.log" -ForegroundColor Red
  $errLog = Join-Path $PSScriptRoot 'logs\vision.err.log'
  if (Test-Path $errLog) {
    Get-Content $errLog -Tail 20 | ForEach-Object { Write-Host $_ }
  }
  exit 1
}

if ($firstRun) {
  Write-Host "Сервер запущен. Нажмите Enter, когда расширение загружено."
  Read-Host | Out-Null
  New-Item -ItemType File -Path $ReadyFlag -Force | Out-Null
}

exit 0
