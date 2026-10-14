# VARA installer for Windows.
#
#   irm https://raw.githubusercontent.com/VARA-TEAM/vara-cli/main/install.ps1 | iex
#
# Options (environment variables, so they work with `| iex`):
#   $env:VARA_VERSION = 'v0.1.0'     install a specific release (default: latest)
#   $env:VARA_REPO    = 'owner/repo' install from a fork
#
# Installs to %LOCALAPPDATA%\vara and adds it to your user PATH. No admin rights,
# nothing else to install: the download includes its own Node.js runtime.
# If the repository is private, sign in once with the GitHub CLI (gh auth login) and
# this script will use it automatically.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = if ($env:VARA_REPO) { $env:VARA_REPO } else { 'VARA-TEAM/vara-cli' }
$version = if ($env:VARA_VERSION) { $env:VARA_VERSION } else { 'latest' }

# Windows PowerShell 5.1 on older .NET has no reliable RuntimeInformation: read the environment instead.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($arch -ne 'AMD64') { throw "VARA has no Windows build for $arch yet (x64 only). Please open an issue at https://github.com/$repo/issues" }
$asset = 'vara-win-x64.zip'

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('vara-install-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp | Out-Null

function Get-FromGh {
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { return $false }
  & gh auth status *> $null
  if ($LASTEXITCODE -ne 0) { return $false }
  $ghArgs = @('-R', $repo, '-p', $asset, '-p', 'SHA256SUMS.txt', '-D', $tmp, '--clobber')
  if ($version -ne 'latest') { $ghArgs = @($version) + $ghArgs }
  & gh release download @ghArgs *> $null
  return ($LASTEXITCODE -eq 0 -and (Test-Path (Join-Path $tmp $asset)))
}

function Get-FromWeb {
  $base = if ($version -eq 'latest') { "https://github.com/$repo/releases/latest/download" } else { "https://github.com/$repo/releases/download/$version" }
  Invoke-WebRequest -Uri "$base/$asset" -OutFile (Join-Path $tmp $asset) -UseBasicParsing
  Invoke-WebRequest -Uri "$base/SHA256SUMS.txt" -OutFile (Join-Path $tmp 'SHA256SUMS.txt') -UseBasicParsing
}

Write-Host "Downloading VARA ($version)..."
if (-not (Get-FromGh)) {
  try { Get-FromWeb }
  catch {
    throw "Could not download the release. If the repository is private, run 'gh auth login' first and try again. ($($_.Exception.Message))"
  }
}

# Verify the download against the published checksums before running anything from it.
$zip = Join-Path $tmp $asset
$line = Get-Content (Join-Path $tmp 'SHA256SUMS.txt') | Where-Object { $_ -match [regex]::Escape($asset) } | Select-Object -First 1
if (-not $line) { throw "SHA256SUMS.txt does not list $asset - refusing to install." }
$expected = ($line -split '\s+')[0].ToLower()
$actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ($expected -ne $actual) { throw "Checksum mismatch (expected $expected, got $actual) - refusing to install." }

$dest = Join-Path $env:LOCALAPPDATA 'vara'
$app = Join-Path $dest 'vara'
New-Item -ItemType Directory -Path $dest -Force | Out-Null
if (Test-Path $app) {
  # A running VARA keeps node.exe locked: move the old copy aside instead of failing.
  $old = Join-Path $dest ('vara.old-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
  Move-Item $app $old
  Remove-Item $old -Recurse -Force -ErrorAction SilentlyContinue
}
# Windows ships bsdtar, which unzips reliably and quickly (Expand-Archive is very slow on 80 MB).
& "$env:SystemRoot\System32\tar.exe" -xf $zip -C $dest
if (-not (Test-Path (Join-Path $app 'vara.cmd'))) { throw 'The archive did not contain VARA - installation failed.' }

# PATH (user level, no admin needed).
# The user PATH can be unset on a fresh account (then it is $null): treat that as empty.
$userPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $app) {
  $newPath = if ($userPath.Trim()) { $userPath.TrimEnd(';') + ';' + $app } else { $app }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
}
if (($env:Path -split ';') -notcontains $app) { $env:Path = $env:Path + ';' + $app }

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

$v = & (Join-Path $app 'vara.cmd') --version
Write-Host ''
Write-Host "VARA $v is installed in $app" -ForegroundColor Green
Write-Host ''
Write-Host 'Next (open a NEW terminal window first):'
Write-Host '  vara setup    connect a provider and pick a model'
Write-Host '  vara          start'
Write-Host '  vara doctor   check that everything works'
