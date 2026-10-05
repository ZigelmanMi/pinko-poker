# start.ps1 — один запуск pin-pok на Windows.
#
#   .\start.ps1
#   двойной щелчок по start.bat
#
# Делает три вещи:
#   1. Создаёт .venv и ставит зависимости, если их ещё нет.
#   2. Собирает чистую папку extension\ и открывает chrome://extensions.
#   3. Поднимает сервер зрения. Окно не закрывать: это и есть сервер.

param(
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONPYCACHEPREFIX = Join-Path $env:TEMP 'pin-pok-pyc'

function Find-SystemPython {
  foreach ($candidate in @('py', 'python', 'python3')) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  return $null
}

function Open-ExtensionsPage {
  if ($NoBrowser) { return }
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  $chrome = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  $ext = Join-Path $PSScriptRoot 'extension'
  if ($chrome) {
    Start-Process -FilePath $chrome -ArgumentList 'chrome://extensions'
  } else {
    Write-Host "Chrome не найден. Откройте chrome://extensions вручную." -ForegroundColor Yellow
  }
  Start-Process explorer.exe -ArgumentList $ext
}

$venvPy = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path $venvPy)) {
  $sys = Find-SystemPython
  if (-not $sys) {
    Write-Host "Python не найден в PATH." -ForegroundColor Red
    Write-Host "Установите Python 3.10+ с галкой Add python.exe to PATH:"
    Write-Host "https://www.python.org/downloads/"
    exit 1
  }
  Write-Host "Создаю .venv через $sys" -ForegroundColor Cyan
  & $sys -m venv (Join-Path $PSScriptRoot '.venv')
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $venvPy)) {
    Write-Host "Не удалось создать .venv." -ForegroundColor Red
    exit 1
  }
}

Write-Host "Python: $venvPy" -ForegroundColor Cyan
& $venvPy --version

& $venvPy -c "import PIL, numpy, cv2" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Ставлю зависимости в .venv..." -ForegroundColor Cyan
  & $venvPy -m pip install -r (Join-Path $PSScriptRoot 'requirements.txt')
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Установка зависимостей не удалась." -ForegroundColor Red
    exit 1
  }
}

Write-Host "Собираю папку extension\ для Chrome..." -ForegroundColor Cyan
& $venvPy (Join-Path $PSScriptRoot 'tools\pack_extension.py')
if ($LASTEXITCODE -ne 0) { exit 1 }
& $venvPy (Join-Path $PSScriptRoot 'tools\preflight.py') 'extension'
if ($LASTEXITCODE -ne 0) { exit 1 }

$alive = $false
try {
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 2
  if ($health.ok) { $alive = $true }
} catch {
  $alive = $false
}

Write-Host ""
Write-Host "Расширение: папка extension\ (не корень проекта)." -ForegroundColor Green
Write-Host "Первый раз: chrome://extensions -> Режим разработчика -> Загрузить распакованное -> extension"
Write-Host "Дальше достаточно этого запуска и кнопки Обновить на карточке расширения."
Write-Host ""

Open-ExtensionsPage

if ($alive) {
  Write-Host "Сервер зрения уже отвечает на http://127.0.0.1:8765/health" -ForegroundColor Green
  Write-Host "Второе окно поднимать не нужно. Enter закроет это окно."
  Read-Host | Out-Null
  exit 0
}

Write-Host "Сервер зрения: http://127.0.0.1:8765/read" -ForegroundColor Green
Write-Host "Это окно — сам сервер. Не закрывайте его, пока нужны карты. Остановка — Ctrl+C."
Write-Host ""
& $venvPy (Join-Path $PSScriptRoot 'vision_server.py')
exit $LASTEXITCODE
