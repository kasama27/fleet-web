# ตั้งค่า named tunnel ครั้งเดียว: login -> สร้าง tunnel -> ผูก DNS ของโดเมนเรา
# หลังจากนี้ start-all.ps1 / tunnel.ps1 จะใช้ https://$Hostname ให้เอง
param(
    [string]$TunnelName = 'fleet',
    [string]$Hostname = 'lb.kasama27.bid'
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    Write-Host "cloudflared not found - winget install --id Cloudflare.cloudflared (then open a NEW terminal)"
    exit 1
}

if (-not (Test-Path "$env:USERPROFILE\.cloudflared\cert.pem")) {
    Write-Host "1/3 login - browser will open, pick the domain kasama27.bid"
    cloudflared tunnel login
}

$list = & cloudflared tunnel list 2>$null | Out-String
if ($list -match "\b$([regex]::Escape($TunnelName))\b") {
    Write-Host "2/3 tunnel '$TunnelName' already exists - skip"
} else {
    Write-Host "2/3 creating tunnel '$TunnelName'"
    cloudflared tunnel create $TunnelName
}

Write-Host "3/3 routing DNS $Hostname -> tunnel '$TunnelName'"
cloudflared tunnel route dns --overwrite-dns $TunnelName $Hostname

Write-Host ""
Write-Host "Done. Run .\start-all.ps1 then open https://$Hostname/fleet" -ForegroundColor Green
Write-Host "Phones: set fleet server to  $Hostname"
