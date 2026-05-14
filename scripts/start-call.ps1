# Trigger a Phase 1 call.
# Usage:   .\scripts\start-call.ps1 <phone-number> [name]
# Example: .\scripts\start-call.ps1 +15551234567 Janet
#
# Reads START_CALL_API_KEY from .env in the repo root and sends it as
# the X-API-Key header. If START_CALL_API_KEY isn't set, the request
# goes without auth (the server only enforces if its own env var is set).
#
# Override the server URL for local testing:
#   $env:SERVER_URL = "http://localhost:3000"
#   .\scripts\start-call.ps1 +15551234567 Janet

param(
    [Parameter(Mandatory=$true, Position=0)]
    [string]$Phone,

    [Parameter(Position=1)]
    [string]$Name = ""
)

# Load .env from repo root so we can pick up START_CALL_API_KEY.
$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile  = Join-Path $repoRoot ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') {
            [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], "Process")
        }
    }
}

$ServerUrl = if ($env:SERVER_URL) { $env:SERVER_URL } else { "https://vapi-interview-webhook.onrender.com" }

$body = @{
    customerNumber = $Phone
    name           = $Name
} | ConvertTo-Json

$headers = @{ "Content-Type" = "application/json" }
if ($env:START_CALL_API_KEY) {
    $headers["X-API-Key"] = $env:START_CALL_API_KEY
}

try {
    $response = Invoke-RestMethod -Uri "$ServerUrl/start-call" -Method Post -Headers $headers -Body $body
    $response | ConvertTo-Json -Depth 5
} catch {
    Write-Host "Request failed: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails.Message) {
        Write-Host $_.ErrorDetails.Message
    }
    exit 1
}
