<#
.SYNOPSIS
  Frees disk space: deletes things in this project that can be rebuilt, after asking you.

.DESCRIPTION
  Deletes only rebuildable folders inside this project:
    web\node_modules     npm packages        (rebuild: npm --prefix web ci)
    web\dist             built website       (rebuild: npm --prefix web run build)
    .venv                Python virtual env  (not used: the jobs use the main Python)
    __pycache__ folders  Python caches       (rebuilt automatically)
    .pytest_cache        test cache
    explore_out          exploration report  (rebuild: python -m jobs.explore)
    lighthouse-reports   speed reports       (rebuild: npm --prefix web run measure)
  With -GlobalCaches it also empties the pip and npm download caches for your whole user
  account (shared with your other projects; they refill when something is installed again).

  Never touches: source code, .env, my_old_data, web\share-kit, .git, anything outside this
  folder (except the two caches above with -GlobalCaches).

  It always lists what it found with sizes and asks "Delete? (y/N)" first. Nothing runs in
  the background and nothing is scheduled.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\clean.ps1 -DryRun
  powershell -ExecutionPolicy Bypass -File .\clean.ps1
  powershell -ExecutionPolicy Bypass -File .\clean.ps1 -GlobalCaches
#>
param(
  [switch]$DryRun,        # only list, never delete
  [switch]$GlobalCaches   # also empty the pip and npm caches of your user account
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Get-SizeBytes([string]$path) {
  $sum = (Get-ChildItem -LiteralPath $path -Recurse -File -Force -ErrorAction SilentlyContinue |
          Measure-Object Length -Sum).Sum
  if ($sum) { [long]$sum } else { 0 }
}
function Format-Size([long]$bytes) {
  if ($bytes -ge 1GB) { '{0:N1} GB' -f ($bytes / 1GB) } else { '{0:N1} MB' -f ($bytes / 1MB) }
}

# ---- what to delete (inside the project only) ----
$targets = @()
foreach ($rel in 'web\node_modules', 'web\dist', '.venv', '.pytest_cache', 'explore_out', 'lighthouse-reports') {
  $p = Join-Path $root $rel
  if (Test-Path -LiteralPath $p) { $targets += $p }
}
# __pycache__ anywhere except inside folders already listed (they go as a whole)
$targets += Get-ChildItem -LiteralPath $root -Recurse -Directory -Force -Filter '__pycache__' -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch '\\(node_modules|\.venv)\\' } |
  Select-Object -ExpandProperty FullName

# Safety net: every target must be inside this project folder.
$targets = $targets | Where-Object { $_.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) }

$caches = @()
if ($GlobalCaches) {
  foreach ($c in @(@{ Name = 'pip cache'; Path = "$env:LOCALAPPDATA\pip\cache" },
                   @{ Name = 'npm cache'; Path = "$env:LOCALAPPDATA\npm-cache" })) {
    if (Test-Path -LiteralPath $c.Path) { $caches += $c }
  }
}

# ---- list ----
Write-Host "Project folder: $root"
Write-Host "Project size now: $(Format-Size (Get-SizeBytes $root))"
Write-Host ''
$total = 0
if (-not $targets -and -not $caches) { Write-Host 'Nothing to clean.'; exit 0 }
foreach ($t in $targets) {
  $size = Get-SizeBytes $t; $total += $size
  Write-Host ('  {0,10}  {1}' -f (Format-Size $size), $t.Substring($root.Length + 1))
}
foreach ($c in $caches) {
  $size = Get-SizeBytes $c.Path; $total += $size
  Write-Host ('  {0,10}  {1} ({2})' -f (Format-Size $size), $c.Name, $c.Path)
}
Write-Host ''
Write-Host "Would free: $(Format-Size $total)"

if ($DryRun) { Write-Host 'Dry run: nothing deleted.'; exit 0 }

# ---- ask ----
$answer = Read-Host 'Delete all of the above? (y/N)'
if ($answer -notmatch '^(y|yes|s|si|sí)$') { Write-Host 'Nothing deleted.'; exit 0 }

foreach ($t in $targets) {
  try { Remove-Item -LiteralPath $t -Recurse -Force; Write-Host "  deleted  $($t.Substring($root.Length + 1))" }
  catch { Write-Warning "Could not delete $t (is the dev server or an editor using it?): $($_.Exception.Message)" }
}
foreach ($c in $caches) {
  if ($c.Name -eq 'pip cache') { python -m pip cache purge | Out-Null }
  else { npm cache clean --force 2>$null | Out-Null }
  Write-Host "  emptied  $($c.Name)"
}
Write-Host ''
Write-Host "Project size now: $(Format-Size (Get-SizeBytes $root))"
Write-Host 'To work on the website again later: npm --prefix web ci'
