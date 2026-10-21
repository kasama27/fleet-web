# Load .env into this process's environment (optional now - server.js auto-generates
# FLEET_PASSWORD/FLEET_SECRET/SESSION_SECRET into config.json on first run if .env is missing)
$envFile = Join-Path $PSScriptRoot '.env'
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([^#=]+?)\s*=\s*(.*)\s*$') {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
        }
    }
}
node (Join-Path $PSScriptRoot 'server.js')
