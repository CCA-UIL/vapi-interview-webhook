# Inspect the Supabase tables. Loads .env automatically.
# Usage:   .\scripts\inspect-db.ps1 [participants|sessions|scheduled_calls]
# Default: shows all three.

param(
    [Parameter(Position=0)]
    [string]$Table = ""
)

# Load .env from repo root
$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile  = Join-Path $repoRoot ".env"
if (-not (Test-Path $envFile)) {
    Write-Host ".env not found at $envFile" -ForegroundColor Red
    exit 1
}
Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') {
        [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], "Process")
    }
}

$url = $env:SUPABASE_URL
$key = $env:SUPABASE_SERVICE_ROLE_KEY
if (-not $url -or -not $key) {
    Write-Host "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing from .env" -ForegroundColor Red
    exit 1
}

$headers = @{
    "apikey"        = $key
    "Authorization" = "Bearer $key"
}

function Show-Table([string]$name) {
    Write-Host ""
    Write-Host "=== $name ===" -ForegroundColor Cyan
    try {
        $r = Invoke-RestMethod -Uri "$url/rest/v1/$name`?select=*&order=created_at.desc&limit=20" -Headers $headers
        $r | ConvertTo-Json -Depth 6
    } catch {
        Write-Host "Failed: $($_.Exception.Message)" -ForegroundColor Red
        if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message }
    }
}

if ($Table) {
    Show-Table $Table
} else {
    Show-Table "participants"
    Show-Table "sessions"
    Show-Table "scheduled_calls"
}
