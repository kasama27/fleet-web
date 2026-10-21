# ติดตั้ง pondy-fleet-web เป็น Windows Service (ผ่าน NSSM) — เปิดเองตอนบูตโดยไม่ต้องล็อกอิน,
# เปิดใหม่เองเมื่อ node crash/ออก, log ลง logs\ แบบหมุนไฟล์
#
#   ติดตั้ง / ติดตั้งทับ:   .\install-service.ps1
#   ถอนออก:               .\install-service.ps1 -Uninstall
#
# รหัสผ่าน/secret อ่านจาก config.json (server.js ใช้ไฟล์นี้เมื่อไม่มี env) — service ไม่อ่าน .env
# ดังนั้นแก้รหัสที่ config.json แล้วสั่ง Restart-Service PondyFleet
param([switch]$Uninstall, [int]$Port = 18788)
$ErrorActionPreference = 'Stop'
$Svc = 'PondyFleet'
$Root = $PSScriptRoot

# ต้องเป็น admin ถึงสร้าง service ได้ — ถ้ายังไม่ใช่ เปิดตัวเองใหม่แบบขอสิทธิ์ (หน้าต่าง UAC)
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    $args2 = @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if ($Uninstall) { $args2 += '-Uninstall' }
    Start-Process powershell -Verb RunAs -ArgumentList $args2
    return
}

# nssm.exe เก็บไว้ใน tools\ ของโปรเจกต์เอง — service ชี้มาที่ไฟล์นี้ ไม่ผูกกับโฟลเดอร์ winget ของ user
$Nssm = Join-Path $Root 'tools\nssm.exe'
if (-not (Test-Path $Nssm)) {
    Write-Host "→ ติดตั้ง NSSM ผ่าน winget (NSSM.NSSM จาก nssm.cc, zip ~350 KB)"
    winget install --id NSSM.NSSM -e --accept-source-agreements --accept-package-agreements | Out-Host
    $found = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter nssm.exe -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\win64\\' } | Select-Object -First 1
    if (-not $found) { throw "หา nssm.exe ไม่เจอหลังติดตั้ง — ดูข้อความ winget ข้างบน" }
    New-Item -ItemType Directory -Force (Join-Path $Root 'tools') | Out-Null
    Copy-Item $found.FullName $Nssm
}

$existing = Get-Service $Svc -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "→ พบ service เดิม — หยุดและลบก่อน"
    & $Nssm stop $Svc | Out-Null
    & $Nssm remove $Svc confirm | Out-Null
}
if ($Uninstall) { Write-Host "✓ ถอน service $Svc แล้ว"; return }

$Node = (Get-Command node -ErrorAction Stop).Source
if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
    Write-Host "→ npm install (ครั้งแรก)"
    Push-Location $Root; npm install | Out-Host; Pop-Location
}
if (-not (Test-Path (Join-Path $Root 'config.json'))) {
    throw "ไม่มี config.json — รัน .\start.ps1 ครั้งหนึ่งก่อน (หรือสร้างเอง) เพื่อให้มีรหัสผ่าน/secret"
}

# node ที่รันค้างจากหน้าต่าง start.ps1 จะจองพอร์ต $Port อยู่ — ปิดก่อน ไม่งั้น service เปิดไม่ขึ้น
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*$Root*server.js*" -or $_.CommandLine -like '*pondy-fleet-web*server.js*' } |
    ForEach-Object { Write-Host "→ ปิด node เดิม (pid $($_.ProcessId))"; Stop-Process -Id $_.ProcessId -Force }

$Logs = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force $Logs | Out-Null

Write-Host "→ สร้าง service $Svc"
& $Nssm install $Svc $Node server.js | Out-Null
& $Nssm set $Svc AppDirectory $Root | Out-Null
& $Nssm set $Svc DisplayName 'Pondy Fleet' | Out-Null
& $Nssm set $Svc Description "pondy-fleet-web dashboard + phone agent hub (port $Port)" | Out-Null
& $Nssm set $Svc AppEnvironmentExtra "PORT=$Port" | Out-Null
# delayed auto start = รอให้เน็ต/ระบบพร้อมก่อนหลังบูต (ไม่ต้องมีใครล็อกอิน)
& $Nssm set $Svc Start SERVICE_DELAYED_AUTO_START | Out-Null
# node ออกด้วยเหตุผลอะไรก็ตาม → เปิดใหม่หลัง 5 วิ; ถ้าล้มภายใน 10 วิแรก NSSM จะหน่วงเพิ่มเองกันวนรัว
& $Nssm set $Svc AppExit Default Restart | Out-Null
& $Nssm set $Svc AppRestartDelay 5000 | Out-Null
& $Nssm set $Svc AppThrottle 10000 | Out-Null
& $Nssm set $Svc AppStdout (Join-Path $Logs 'fleet.log') | Out-Null
& $Nssm set $Svc AppStderr (Join-Path $Logs 'fleet.log') | Out-Null
& $Nssm set $Svc AppRotateFiles 1 | Out-Null
& $Nssm set $Svc AppRotateOnline 1 | Out-Null
& $Nssm set $Svc AppRotateBytes 5242880 | Out-Null
# Windows เองก็สั่ง restart ถ้าตัว nssm ล้ม (ชั้นที่สอง)
sc.exe failure $Svc reset= 86400 actions= restart/5000/restart/5000/restart/30000 | Out-Null

Write-Host "→ เริ่ม service"
& $Nssm start $Svc | Out-Null
Start-Sleep -Seconds 4
$ok = $false
for ($i = 0; $i -lt 10 -and -not $ok; $i++) {
    try { $ok = (Invoke-WebRequest http://127.0.0.1:$Port/fleet/login -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { Start-Sleep -Seconds 2 }
}
Get-Service $Svc | Format-Table Status, StartType, Name, DisplayName -AutoSize | Out-Host
if ($ok) {
    Write-Host "✓ fleet รันเป็น service แล้ว — http://127.0.0.1:$Port/fleet  (log: logs\fleet.log)"
} else {
    Write-Host "!! service สร้างแล้วแต่หน้าเว็บยังไม่ตอบ — ดู logs\fleet.log" -ForegroundColor Red
}
