# Trigger a Phase 1 call.
# Usage:   .\scripts\start-call.ps1 <phone-number> [name]
# Example: .\scripts\start-call.ps1 +15551234567 Janet
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

$ServerUrl = if ($env:SERVER_URL) { $env:SERVER_URL } else { "https://vapi-interview-webhook.onrender.com" }

$body = @{
    customerNumber = $Phone
    name           = $Name
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri "$ServerUrl/start-call" -Method Post -ContentType "application/json" -Body $body
    $response | ConvertTo-Json -Depth 5
} catch {
    Write-Host "Request failed: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails.Message) {
        Write-Host $_.ErrorDetails.Message
    }
    exit 1
}
