# One script: install deps (first run only), then start the Node server and the
# cloudflared tunnel each in their own window so you can see both logs live.
# Run this every time you want pondy-fleet-web up (or wire it to Task Scheduler / NSSM later).
# -Port: 8788 is inside a Windows reserved/excluded port range on some machines
# (Hyper-V/WinNAT grabs it), where binding fails outright - hence the non-default.
param([int]$Port = 18788)
$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js not found in PATH - install it first (https://nodejs.org)."
    exit 1
}
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    Write-Host "cloudflared not found in PATH - install it first: winget install --id Cloudflare.cloudflared"
    Write-Host "(then open a NEW terminal window and re-run this script)"
    exit 1
}

if (-not (Test-Path (Join-Path $PSScriptRoot 'node_modules'))) {
    Write-Host "Installing dependencies (first run only)..."
    Push-Location $PSScriptRoot
    npm install
    Pop-Location
}

# ติดตั้งเป็น service แล้ว (install-service.ps1) = node รันอยู่เบื้องหลังเอง — เปิดซ้ำจะชนพอร์ต $Port
$svc = Get-Service PondyFleet -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.Status -ne 'Running') { Write-Host "PondyFleet service is $($svc.Status) - start it with: Start-Service PondyFleet (admin)" }
    else { Write-Host "Node server runs as the PondyFleet service - not opening a window for it." }
} else {
    Write-Host "Starting Node server in a new window..."
    Start-Process powershell -ArgumentList @(
        '-NoExit', '-Command',
        "`$env:PORT='$Port'; Set-Location '$PSScriptRoot'; .\start.ps1"
    )
    Start-Sleep -Seconds 2
}

Write-Host "Starting cloudflared tunnel in a new window..."
# tunnel.ps1 = cloudflared + เปิดใหม่เองเมื่อหลุด + เปิดลิงก์ใหม่ในเบราว์เซอร์ให้อัตโนมัติ
Start-Process powershell -ArgumentList @(
    '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$(Join-Path $PSScriptRoot 'tunnel.ps1')`"", '-Port', "$Port"
)

Write-Host ""
Write-Host "Two windows opened:"
Write-Host "  1) Node server   -> shows the LAN URL (http://<lan-ip>:$Port/fleet) and the login password"
Write-Host "  2) cloudflared   -> https://lb.kasama27.bid/fleet (named tunnel) or a trycloudflare URL if setup-named-tunnel.ps1 was never run"
Write-Host "Keep both windows open. Closing either one stops that part."
