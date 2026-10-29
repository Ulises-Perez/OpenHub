# Daily catalog refresh without GitHub Actions.
# Registered with: schtasks /create /tn "OpenHub crawl" /sc daily /st 05:00 ^
#   /tr "powershell -NoProfile -ExecutionPolicy Bypass -File <this file>"
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$log = Join-Path $root "publish.log"
Set-Location $root

function Note($text) { "[$(Get-Date -Format s)] $text" | Add-Content $log }

Note "start"
try {
    $env:GITHUB_TOKEN = (& "C:\Program Files\GitHub CLI\gh.exe" auth token).Trim()
    if (-not $env:GITHUB_TOKEN) { throw "gh auth token returned nothing; run gh auth login" }
    node crawl.mjs *>> $log
    if ($LASTEXITCODE -ne 0) { throw "crawl exited $LASTEXITCODE" }
    & "C:\Program Files\Git\bin\bash.exe" scripts/publish-data.sh *>> $log
    if ($LASTEXITCODE -ne 0) { throw "publish exited $LASTEXITCODE" }
    Note "ok"
}
catch {
    Note "FAILED: $_"
    exit 1
}
