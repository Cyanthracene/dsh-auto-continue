# uninstall-profile.ps1 — remove dsh-auto-continue from a DSH profile.
#
# Removes exactly the two things install-profile.ps1 added:
#   1. the insert row it appended to <profile>\cordis.patch.yml
#   2. the directory link at <profile>\node_modules\dsh-auto-continue
#
# Rows the settings service wrote (id `auto-continue`, carrying `config:` and no
# `insert:`) are deliberately left alone: they are the user's saved settings, they
# mount nothing on their own, and deleting them would throw away a configuration
# the user may want back after reinstalling. The link is removed with `rmdir`,
# which deletes the link itself and never the plugin directory it points at.

param(
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
$LinkPath = Join-Path $Profile "node_modules\$PluginName"

if (-not (Test-Path $PatchFile)) { throw "no cordis.patch.yml at '$PatchFile'" }

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$raw = [System.IO.File]::ReadAllText($PatchFile, $Utf8NoBom)

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $DshHome ".dsh-rollback-$PluginName-uninstall-$stamp"
New-Item -ItemType Directory -Force -Path $backup | Out-Null
Copy-Item $PatchFile (Join-Path $backup 'cordis.patch.yml') -Force
Say "backup = $backup"

# Remove the three-line insert block, with whatever terminator the file uses.
$eol = '(?:\r\n|\n|\r)'
$block = '(?m)^[ \t]*-[ \t]*insert:[ \t]*' + $eol + '[ \t]*-[ \t]*id:[ \t]*' + [regex]::Escape($RowId) + '[ \t]*' + $eol + '[ \t]*name:[ \t]*' + [regex]::Escape($PluginName) + '[ \t]*' + $eol + '?'
$matches = ([regex]::Matches($raw, $block)).Count
if ($matches -eq 0) {
  Say 'no insert row found; nothing to remove from the patch layer'
} else {
  $raw = [regex]::Replace($raw, $block, '')
  [System.IO.File]::WriteAllText($PatchFile, $raw, $Utf8NoBom)
  Say "removed $matches insert row(s)"
}

if (Test-Path $LinkPath) {
  # cmd's rmdir removes a junction itself and does not follow it.
  cmd /c rmdir "$LinkPath" | Out-Null
  Say "removed link $LinkPath"
} else {
  Say 'no profile link present'
}

Say 'refresh or restart DSH to drop the row.'
