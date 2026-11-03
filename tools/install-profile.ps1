# install-profile.ps1 — install dsh-auto-continue into a DSH profile.
#
# Two changes, nothing else:
#   1. a directory link at <profile>\node_modules\dsh-auto-continue
#   2. one appended insert row in <profile>\cordis.patch.yml
#
# It does NOT touch package.json, does NOT run pnpm, does NOT restart DSH, and
# does NOT modify anything outside the profile. Undo with uninstall-profile.ps1.
#
# Both files belong to the user, not to this plugin, so both writes are careful:
# the patch layer is read and rewritten through .NET's UTF-8 codec (PowerShell's
# -Encoding utf8 writes a BOM on 5.1, and a BOM-less file read without -Encoding
# is decoded as the system ANSI codepage, which would mangle its CJK text), the
# terminator already in the file is reused, and a backup is taken first.

param(
  [string]$PackageDir = (Split-Path $PSScriptRoot -Parent),
  [string]$DshHome = '',
  [string]$ProfileName = 'desktop'
)

$ErrorActionPreference = 'Stop'
$PluginName = 'dsh-auto-continue'
$RowId = 'auto-continue'

function Say($m) { Write-Host $m }

if ($DshHome -eq '') {
  if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME } else { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
}

$Profile = Join-Path (Join-Path $DshHome 'profiles') $ProfileName
$PatchFile = Join-Path $Profile 'cordis.patch.yml'
$Manifest = Join-Path $Profile 'package.json'
$LinkPath = Join-Path $Profile "node_modules\$PluginName"

if (-not (Test-Path (Join-Path $PackageDir 'package.json'))) { throw "no package.json at '$PackageDir'" }
if (-not (Test-Path $Manifest)) { throw "no profile at '$Profile'" }
if (-not (Test-Path $PatchFile)) { throw "no cordis.patch.yml at '$PatchFile'" }

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$raw = [System.IO.File]::ReadAllText($PatchFile, $Utf8NoBom)

Say "package : $PackageDir"
Say "profile : $Profile"

Say '=== 1/3 back up ==='
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $DshHome ".dsh-rollback-$PluginName-$stamp"
New-Item -ItemType Directory -Force -Path $backup | Out-Null
Copy-Item $PatchFile (Join-Path $backup 'cordis.patch.yml') -Force
"hadNodeModulesLink=$(Test-Path $LinkPath)" | Set-Content (Join-Path $backup 'MANIFEST.txt') -Encoding ascii
Say "  backup = $backup"

Say '=== 2/3 link the package into the profile ==='
if (Test-Path $LinkPath) {
  Say '  link already present'
} else {
  New-Item -ItemType Junction -Path $LinkPath -Target $PackageDir -Force | Out-Null
  Say "  $LinkPath -> $PackageDir"
}

Say '=== 3/3 append the row ==='
# Count *insert* rows, not occurrences of the name: once the settings card saves
# a value, the settings service appends a row of its own (`- id: auto-continue`
# with a `config:` block and no `insert:`) which mounts nothing. A name search
# would see that row, call the plugin installed, and leave it off the graph.
$eol = '(?:\r\n|\n|\r)'
$pattern = '(?m)^[ \t]*-[ \t]*insert:[ \t]*' + $eol + '[ \t]*-[ \t]*id:[ \t]*' + [regex]::Escape($RowId) + '[ \t]*' + $eol + '[ \t]*name:[ \t]*' + [regex]::Escape($PluginName) + '[ \t]*'
$rows = ([regex]::Matches($raw, $pattern)).Count
if ($rows -gt 0) {
  Say "  an insert row is already present ($rows); leaving it alone"
} else {
  $newline = if ($raw.Contains("`r`n")) { "`r`n" } else { "`n" }
  $block = '- insert:' + $newline + '    - id: ' + $RowId + $newline + '      name: ' + $PluginName + $newline
  if ($raw.Length -gt 0 -and -not $raw.EndsWith("`n") -and -not $raw.EndsWith("`r")) { $raw += $newline }
  [System.IO.File]::WriteAllText($PatchFile, $raw + $block, $Utf8NoBom)
  Say '  appended 3 lines'
}

Say '=== verify ==='
$after = [System.IO.File]::ReadAllText($PatchFile, $Utf8NoBom)
Say "  insert rows for $RowId : $(([regex]::Matches($after, $pattern)).Count)"
Say "  link target      : $((Get-Item $LinkPath -Force).Target)"
# The profile patch layer must still parse and must still hold its CJK text.
Say "  CJK intact       : $($after.Contains([char]0x8F93 + [char]0x51FA))"
Say '  restart or refresh DSH to pick the row up.'
