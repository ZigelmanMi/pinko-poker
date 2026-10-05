# Останавливает фоновый сервер зрения (порт 8765).
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$procIds = New-Object System.Collections.Generic.List[int]
netstat -ano | ForEach-Object {
  if ($_ -match '^\s*TCP\s+127\.0\.0\.1:8765\s+\S+\s+LISTENING\s+(\d+)\s*$') {
    $procIds.Add([int]$Matches[1])
  }
}

$unique = $procIds | Select-Object -Unique
if (-not $unique) {
  Write-Host "Сервер не запущен."
  exit 0
}

foreach ($procId in $unique) {
  Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  Write-Host "Сервер остановлен."
}

exit 0
