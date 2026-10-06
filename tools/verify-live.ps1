# Live verification helper for dsh-plugin-delete-conversation.
#
# Checks, against a RUNNING DSH Web GUI on this machine:
#   1. the boot graph advertises the plugin's browser row, and the served bundle
#      carries the current source (revision + marker strings);
#   2. GET  <prefix>/doctor   reports every required seam as ok;
#   3. POST <prefix>/delete   refuses a request without the custom header (403);
#   4. POST <prefix>/delete   with the header and a FABRICATED session id returns a
#      well-formed answer, which exercises the real storage domain, the real
#      Workspace.detachSession and the real projection-cache table without
#      deleting anything.
#
# Usage:  pwsh -File tools/verify-live.ps1 [-Base http://127.0.0.1:19387]

param([string]$Base = 'http://127.0.0.1:19387')

$ErrorActionPreference = 'Continue'
$prefix = '/dsh-plugin-delete-conversation'
$fabricated = 'session-00000000-0000-4000-8000-000000000000'
$failures = 0

function Section([string]$text) { Write-Host ''; Write-Host "== $text" }
function Check([string]$label, [bool]$passed, [string]$detail = '') {
  if ($passed) { Write-Host "  ok    $label" }
  else { Write-Host "  FAIL  $label $detail"; $script:failures++ }
}

function Get-Text([string]$url, [string]$method = 'GET', $headers = $null, [string]$body = $null) {
  $params = @{ Uri = $url; Method = $method; UseBasicParsing = $true; TimeoutSec = 30 }
  if ($headers) { $params.Headers = $headers }
  if ($body) { $params.Body = $body; $params.ContentType = 'application/json' }
  try {
    $response = Invoke-WebRequest @params
    return @{ status = $response.StatusCode; text = $response.Content }
  } catch {
    $status = 0
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    return @{ status = $status; text = [string]$_.ErrorDetails.Message }
  }
}

Section 'browser bundle'
$index = Get-Text "$Base/"
if ($index.status -ne 200) {
  Check 'the GUI answers on the given port' $false "(status $($index.status))"
} else {
  $match = [regex]::Match($index.text, '"id":"dsh-plugin-delete-conversation"[^}]*?"url":"([^"]+)"')
  if (-not $match.Success) {
    Check 'the boot graph advertises the plugin row' $false '(no row for dsh-plugin-delete-conversation: is the plugin installed and enabled?)'
  } else {
    Check 'the boot graph advertises the plugin row' $true
    $rel = $match.Groups[1].Value
    $bundle = Get-Text "$Base/$rel"
    Check 'the bundle is served' ($bundle.status -eq 200 -and $bundle.text.Length -gt 500) "(status $($bundle.status), $($bundle.text.Length) bytes)"
    Check 'the served bundle is the current source' $bundle.text.Contains('dsh-delete-conversation-hint') '(marker missing: the registry is serving an older revision - restart DSH)'
    Check 'the bundle declares the slots injection' $bundle.text.Contains("exports.inject")
  }
}

Section 'host doctor route'
$doctor = Get-Text "$Base$prefix/doctor"
Check 'doctor answers JSON' ($doctor.status -eq 200 -and $doctor.text.StartsWith('{')) "(status $($doctor.status))"
if ($doctor.text.StartsWith('{')) {
  $report = $doctor.text | ConvertFrom-Json
  Check 'every required seam is present' ($report.ok -eq $true) "(missing: $($report.requiredFailures -join ', '))"
  foreach ($entry in $report.checks) {
    if ($entry.level -eq 'required') { Check "  $($entry.id)" $entry.ok $entry.detail }
  }
  Write-Host "  version=$($report.version) dshHome=$($report.dshHome)"
}

Section 'route guards'
$noHeader = Get-Text "$Base$prefix/delete" 'POST' $null "{`"sessionId`":`"$fabricated`"}"
Check 'a request without the custom header is refused' ($noHeader.status -eq 403) "(status $($noHeader.status))"

Section 'real services, fabricated session id (deletes nothing)'
$guarded = Get-Text "$Base$prefix/delete" 'POST' @{ 'x-dsh-plugin-delete-conversation' = '1' } "{`"sessionId`":`"$fabricated`"}"
Check 'the call returns JSON' ($guarded.status -eq 200 -and $guarded.text.StartsWith('{')) "(status $($guarded.status) $($guarded.text))"
if ($guarded.text.StartsWith('{')) {
  $result = $guarded.text | ConvertFrom-Json
  Check 'the real storage domain + registry accepted every call' ($result.ok -eq $true) "$($result.code): $($result.message)"
  Write-Host "  removed=$($result.removed | ConvertTo-Json -Compress)"
  Write-Host "  warnings=$($result.warnings | ConvertTo-Json -Compress)"
}

Section 'result'
if ($failures -eq 0) { Write-Host 'ALL CHECKS PASSED'; exit 0 }
Write-Host "$failures CHECK(S) FAILED"; exit 1
