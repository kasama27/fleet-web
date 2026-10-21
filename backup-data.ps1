# สำรอง data\*.json + config.json เป็น zip ใน backups\ เก็บ 14 วันล่าสุด
# รันมือ:  powershell -ExecutionPolicy Bypass -File .\backup-data.ps1
# ตั้งให้รันทุกชั่วโมง (Task Scheduler):
#   schtasks /Create /SC HOURLY /TN PondyFleetBackup /TR "powershell -NoProfile -ExecutionPolicy Bypass -File \"$PSScriptRoot\backup-data.ps1\""
# หมายเหตุ: config.json มี secret — โฟลเดอร์ backups\ ต้องไม่เข้า git และไม่แชร์
param([int]$KeepDays = 14, [string]$CopyTo = '')

$root = $PSScriptRoot
$dest = Join-Path $root 'backups'
New-Item -ItemType Directory -Force $dest | Out-Null

$files = @(Get-ChildItem (Join-Path $root 'data') -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.json', '.jsonl' })
$cfg = Join-Path $root 'config.json'
if (Test-Path $cfg) { $files += Get-Item $cfg }
if (-not $files.Count) { Write-Host 'ไม่มีไฟล์ให้สำรอง'; exit 0 }

# คัดลอกไปโฟลเดอร์ชั่วคราวก่อน zip — fleet.js เขียนไฟล์ด้วย tmp+rename จึงอ่านได้ไม่ขาดครึ่ง แต่กันไฟล์ถูกล็อกไว้
$tmp = Join-Path $env:TEMP ("pondy-bk-" + [guid]::NewGuid())
New-Item -ItemType Directory $tmp | Out-Null
try {
  foreach ($f in $files) { Copy-Item $f.FullName (Join-Path $tmp $f.Name) -ErrorAction Stop }
  $zip = Join-Path $dest ("{0:yyyyMMdd-HHmm}.zip" -f (Get-Date))
  Compress-Archive -Path (Join-Path $tmp '*') -DestinationPath $zip -Force
  Write-Host "สำรองแล้ว: $zip ($($files.Count) ไฟล์)"
  if ($CopyTo) { New-Item -ItemType Directory -Force $CopyTo | Out-Null; Copy-Item $zip $CopyTo -Force }
} finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }

Get-ChildItem $dest -Filter *.zip | Where-Object LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) | Remove-Item -Force
