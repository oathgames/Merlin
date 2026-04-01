# Build AutoCMO.exe — obfuscated single-file binary
# Requires: Go installed (https://go.dev/dl/), garble (go install mvdan.cc/garble@latest)

$ErrorActionPreference = "Stop"
Push-Location $PSScriptRoot

Write-Host "Building AutoCMO.exe (obfuscated)..." -ForegroundColor Cyan

$env:GOOS = "windows"
$env:GOARCH = "amd64"
$env:CGO_ENABLED = "0"

# Use garble for obfuscation — strips symbols, obfuscates strings
$garble = "$env:GOPATH\bin\garble.exe"
if (-not (Test-Path $garble)) {
    $garble = "garble"
}

& $garble -literals -tiny build -ldflags="-s -w" -o "AutoCMO.exe" .

if ($LASTEXITCODE -eq 0) {
    $size = [math]::Round((Get-Item "AutoCMO.exe").Length / 1MB, 1)
    Write-Host "[OK] Built AutoCMO.exe (${size} MB, obfuscated)" -ForegroundColor Green
    Write-Host ""
    Write-Host "To deploy:" -ForegroundColor Yellow
    Write-Host "  1. Copy AutoCMO.exe to .claude/tools/"
    Write-Host "  2. Copy autocmo-config.json to .claude/tools/"
    Write-Host "  3. Copy cmo.md to .claude/commands/"
} else {
    Write-Host "[FAIL] Build failed" -ForegroundColor Red
}

Pop-Location
