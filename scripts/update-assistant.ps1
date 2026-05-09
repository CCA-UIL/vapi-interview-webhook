# Push the local prompt file to the Vapi assistant's system prompt.
# Usage:
#   .\scripts\update-assistant.ps1
#   .\scripts\update-assistant.ps1 eric_project\prompts\Eric_system_prompt_phase1.xml
#   .\scripts\update-assistant.ps1 <prompt-file> <assistant-id>
#
# Defaults: prompt = eric_project\prompts\Eric_system_prompt_phase1.xml,
#           assistant id = $env:ASSISTANT_ID from .env
#
# Uses curl.exe (ships with Windows 10+) and node.exe for JSON munging.
# PowerShell 5.1's Invoke-RestMethod hangs on large PATCH bodies, hence curl.

param(
    [Parameter(Position=0)]
    [string]$PromptFile = "eric_project\prompts\Eric_system_prompt_phase1.xml",

    [Parameter(Position=1)]
    [string]$AssistantId = ""
)

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

if (-not $AssistantId) { $AssistantId = $env:ASSISTANT_ID }
$apiKey = $env:VAPI_API_KEY

if (-not $apiKey)      { Write-Host "VAPI_API_KEY missing from .env" -ForegroundColor Red; exit 1 }
if (-not $AssistantId) { Write-Host "AssistantId not provided and ASSISTANT_ID not in .env" -ForegroundColor Red; exit 1 }

$promptPath = if ([System.IO.Path]::IsPathRooted($PromptFile)) { $PromptFile } else { Join-Path $repoRoot $PromptFile }
if (-not (Test-Path $promptPath)) {
    Write-Host "Prompt file not found: $promptPath" -ForegroundColor Red
    exit 1
}

# Use repo root as working dir for temp files
Set-Location $repoRoot

$tmpCurrent  = Join-Path $repoRoot "vapi_current.json"
$tmpPatch    = Join-Path $repoRoot "vapi_patch.json"
$tmpResponse = Join-Path $repoRoot "vapi_response.json"

try {
    Write-Host "Fetching current assistant config..." -ForegroundColor Cyan
    $fetchOut = & curl.exe -s -w "%{http_code}" -H "Authorization: Bearer $apiKey" "https://api.vapi.ai/assistant/$AssistantId" -o $tmpCurrent
    if ($fetchOut -ne "200") {
        Write-Host "GET /assistant/$AssistantId returned HTTP $fetchOut" -ForegroundColor Red
        if (Test-Path $tmpCurrent) { Get-Content $tmpCurrent }
        exit 1
    }

    Write-Host "Building PATCH body..." -ForegroundColor Cyan
    $nodeScript = @"
const fs = require('fs');
const cur = JSON.parse(fs.readFileSync('vapi_current.json','utf8'));
const p   = fs.readFileSync('$($promptPath -replace '\\','\\\\')','utf8');
const oldSize = (cur.model.messages?.[0]?.content||'').length;
console.log('Assistant:      ' + cur.name);
console.log('Assistant ID:   $AssistantId');
console.log('Current prompt: ' + oldSize + ' chars');
console.log('New prompt:     ' + p.length + ' chars');
cur.model.messages = [{role:'system', content:p}];
fs.writeFileSync('vapi_patch.json', JSON.stringify({model: cur.model}));
"@
    $nodeOut = & node -e $nodeScript
    if ($LASTEXITCODE -ne 0) { Write-Host "node failed building PATCH body" -ForegroundColor Red; exit 1 }
    $nodeOut | ForEach-Object { Write-Host $_ }

    Write-Host ""
    Write-Host "Patching assistant..." -ForegroundColor Cyan
    $patchCode = & curl.exe -s -w "%{http_code}" -X PATCH -H "Authorization: Bearer $apiKey" -H "Content-Type: application/json" --data-binary "@vapi_patch.json" "https://api.vapi.ai/assistant/$AssistantId" -o $tmpResponse
    if ($patchCode -ne "200") {
        Write-Host "PATCH returned HTTP $patchCode" -ForegroundColor Red
        if (Test-Path $tmpResponse) { Get-Content $tmpResponse }
        exit 1
    }

    $verifyOut = & node -e "const r=JSON.parse(require('fs').readFileSync('vapi_response.json','utf8')); console.log((r.model?.messages?.[0]?.content||'').length);"
    Write-Host "Updated. Vapi reports prompt size: $verifyOut chars" -ForegroundColor Green
}
finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $tmpCurrent, $tmpPatch, $tmpResponse
}
