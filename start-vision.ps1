# start-vision.ps1 — запуск локального сервера зрения карт на Windows
#
#   .\start-vision.ps1             запустить сервер
#   .\start-vision.ps1 -Install    сначала установить зависимости
#
# Сервер должен работать всё время, пока вы играете: он читает карты со
# скриншотов вкладки. Закроете окно — карты перестанут распознаваться.

param(
  [switch]$Install,
  [string]$Python = ""
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

# Без этого Python пишет __pycache__, и Chrome не грузит расширение:
# имена на «_» в папке расширения запрещены.
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONIOENCODING = 'utf-8'

function Find-Python {
  param([string]$Hint)
  if ($Hint) { return $Hint }
  foreach ($candidate in @('python', 'python3', 'py')) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  return $null
}

$py = Find-Python -Hint $Python
if (-not $py) {
  Write-Host "Python не найден в PATH." -ForegroundColor Red
  Write-Host "Установите Python 3.10+ и повторите: https://www.python.org/downloads/"
  exit 1
}

Write-Host "Python: $py" -ForegroundColor Cyan
& $py --version

if ($Install) {
  Write-Host "`nУстанавливаю зависимости из requirements.txt..." -ForegroundColor Cyan
  & $py -m pip install -r requirements.txt
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Установка зависимостей не удалась." -ForegroundColor Red
    exit 1
  }
}

# Проверим, что нужные модули на месте, и подскажем команду, если нет.
& $py -c "import PIL, numpy, cv2" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "`nНе хватает зависимостей (Pillow / numpy / opencv)." -ForegroundColor Yellow
  Write-Host "Запустите: .\start-vision.ps1 -Install" -ForegroundColor Yellow
  exit 1
}

# Порт занят? Скорее всего сервер уже запущен.
$busy = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  Write-Host "`nПорт 8765 уже слушается — вероятно, сервер зрения уже запущен." -ForegroundColor Yellow
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 3
    Write-Host ("Ответ /health: " + ($health | ConvertTo-Json -Compress)) -ForegroundColor Green
    Write-Host "Сервер уже работает, второй поднимать не нужно." -ForegroundColor Green
    exit 0
  } catch {
    Write-Host "Но /health не отвечает. Закройте старый процесс и повторите." -ForegroundColor Red
    exit 1
  }
}

Write-Host "`nЗапускаю сервер зрения: http://127.0.0.1:8765/read" -ForegroundColor Green
Write-Host "Не закрывайте это окно во время игры. Остановка — Ctrl+C.`n" -ForegroundColor Gray

& $py vision_server.py
