# เปิด cloudflared tunnel ไปที่ fleet (127.0.0.1:$Port — ค่าเริ่ม 18788) และดูแลให้:
#  - cloudflared ตาย/หลุด → เปิดใหม่เองใน 5 วิ
# โหมด named (ค่าเริ่ม): ใช้ tunnel ชื่อ $TunnelName + โดเมนของตัวเอง ($Hostname) — ลิงก์คงที่ ไม่เปลี่ยนทุกครั้ง
#   ต้อง setup ครั้งเดียวด้วย .\setup-named-tunnel.ps1 (ถ้ายังไม่ได้ทำ จะตกไปใช้ quick tunnel ให้เอง)
# โหมด quick (-Quick หรือยังไม่ได้ setup): ลิงก์ trycloudflare เปลี่ยนทุกครั้งที่เริ่มใหม่ — จดลง data\tunnel-url.txt
#   และเปิด <ลิงก์>/fleet ในเบราว์เซอร์ให้เอง มือถือต้องแก้ช่องเซิร์ฟเวอร์เป็นชื่อโฮสต์ใหม่
param(
    [int]$Port = 18788,
    [string]$TunnelName = 'fleet',
    [string]$Hostname = 'lb.kasama27.bid',
    [switch]$Quick
)
$ErrorActionPreference = 'Continue'
$UrlFile = Join-Path $PSScriptRoot 'data\tunnel-url.txt'
$last = ''
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    Write-Host "cloudflared not found - winget install --id Cloudflare.cloudflared" -ForegroundColor Red
    return
}

# โหมด token: สร้าง tunnel ในหน้าเว็บ Cloudflare (Zero Trust > Networks > Tunnels) แล้ววาง token ลง data\tunnel-token.txt
#   ไม่ต้อง cloudflared login / cert.pem — ปลายทาง (lb.kasama27.bid -> http://127.0.0.1:18788) ตั้งในหน้าเว็บ
$TokenFile = Join-Path $PSScriptRoot 'data\tunnel-token.txt'
if (-not $Quick -and (Test-Path $TokenFile)) {
    $token = (Get-Content $TokenFile -Raw).Trim()
    Set-Content -Path $UrlFile -Value "https://$Hostname" -Encoding ascii
    Write-Host "=================================================================" -ForegroundColor Green
    Write-Host " URL    : https://$Hostname/fleet  (token tunnel)" -ForegroundColor Green
    Write-Host " phones : set fleet server to  $Hostname" -ForegroundColor Green
    Write-Host "=================================================================" -ForegroundColor Green
    while ($true) {
        Write-Host "[$(Get-Date -Format HH:mm:ss)] starting cloudflared (token) -> $Hostname"
        & cloudflared tunnel --no-autoupdate run --token $token
        Write-Host "[$(Get-Date -Format HH:mm:ss)] cloudflared exited - restarting in 5s" -ForegroundColor Yellow
        Start-Sleep -Seconds 5
    }
}

# มี named tunnel แล้วหรือยัง (cloudflared tunnel list ต้อง login แล้ว และเจอชื่อ $TunnelName)
$named = $false
if (-not $Quick) {
    $list = & cloudflared tunnel list 2>$null | Out-String
    if ($list -match "\b$([regex]::Escape($TunnelName))\b") { $named = $true }
    else { Write-Host "named tunnel '$TunnelName' not found - run .\setup-named-tunnel.ps1 once. Falling back to quick tunnel." -ForegroundColor Yellow }
}

if ($named) {
    Set-Content -Path $UrlFile -Value "https://$Hostname" -Encoding ascii
    Write-Host "=================================================================" -ForegroundColor Green
    Write-Host " URL    : https://$Hostname/fleet" -ForegroundColor Green
    Write-Host " phones : set fleet server to  $Hostname" -ForegroundColor Green
    Write-Host "=================================================================" -ForegroundColor Green
    while ($true) {
        Write-Host "[$(Get-Date -Format HH:mm:ss)] starting cloudflared tunnel '$TunnelName' -> http://127.0.0.1:$Port"
        & cloudflared tunnel --no-autoupdate run --url http://127.0.0.1:$Port $TunnelName
        Write-Host "[$(Get-Date -Format HH:mm:ss)] cloudflared exited - restarting in 5s" -ForegroundColor Yellow
        Start-Sleep -Seconds 5
    }
}

while ($true) {
    Write-Host "[$(Get-Date -Format HH:mm:ss)] starting cloudflared quick tunnel -> http://127.0.0.1:$Port"
    # cloudflared เขียน log (รวมลิงก์) ออก stderr — 2>&1 เพื่อให้อ่านได้ทีละบรรทัด
    & cloudflared tunnel --no-autoupdate --url http://127.0.0.1:$Port 2>&1 | ForEach-Object {
        $line = "$_"
        Write-Host $line
        if ($line -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
            $u = $Matches[0]
            if ($u -ne $last) {
                $last = $u
                $hostName = $u -replace '^https://', ''
                Set-Content -Path $UrlFile -Value $u -Encoding ascii
                Write-Host ""
                Write-Host "=================================================================" -ForegroundColor Green
                Write-Host " NEW URL : $u/fleet" -ForegroundColor Green
                Write-Host " phones  : set fleet server to  $hostName" -ForegroundColor Green
                Write-Host "=================================================================" -ForegroundColor Green
                Write-Host ""
                Start-Process "$u/fleet"
            }
        }
    }
    Write-Host "[$(Get-Date -Format HH:mm:ss)] cloudflared exited - restarting in 5s" -ForegroundColor Yellow
    Start-Sleep -Seconds 5
}
