# Downloads node.exe from nodejs.org and checks its SHA-256 against the official SHASUMS256.txt.
param(
  [Parameter(Mandatory = $true)][string]$OutFile,
  [string]$Version = 'v22.22.0'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
$base = "https://nodejs.org/dist/$Version"
$name = "$arch/node.exe"

Invoke-WebRequest -Uri "$base/$name" -OutFile $OutFile -UseBasicParsing
$sums = (Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -UseBasicParsing).Content
$line = ($sums -split "`n") | Where-Object { $_ -match ('\s' + [regex]::Escape($name) + '\s*$') } | Select-Object -First 1
if (-not $line) { Remove-Item $OutFile -Force; throw "No checksum for $name" }
$expected = ($line.Trim() -split '\s+')[0].ToLower()
$actual = (Get-FileHash -Path $OutFile -Algorithm SHA256).Hash.ToLower()
if ($expected -ne $actual) {
  Remove-Item $OutFile -Force
  throw "Checksum mismatch for node.exe (expected $expected, got $actual)"
}
Write-Host "node.exe downloaded and verified ($Version, $arch)"
