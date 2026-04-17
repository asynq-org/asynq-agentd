param(
  [string]$SourceDir = "",
  [string]$InstallDir = "",
  [string]$RuntimeHome = "",
  [string]$ServiceMode = "user",
  [string]$PublicUrl = "",
  [string]$AccessMode = "",
  [string]$HostBind = "",
  [string]$Port = "7433",
  [switch]$SkipSpeechSetup
)

$ErrorActionPreference = "Stop"
$serviceModeProvided = $PSBoundParameters.ContainsKey("ServiceMode")
$portProvided = $PSBoundParameters.ContainsKey("Port")

function Get-WorkspaceVersion {
  param(
    [Parameter(Mandatory = $true)][string]$Root
  )

  try {
    $package = Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
    if ($package.version) {
      return [string]$package.version
    }
  } catch {
  }

  return "dev"
}

function Show-Banner {
  param(
    [Parameter(Mandatory = $true)][string]$Version
  )

  Write-Host ""
  Write-Host " █████╗ ███████╗██╗   ██╗███╗   ██╗ ██████╗        █████╗  ██████╗ ███████╗███╗   ██╗████████╗██████╗ "
  Write-Host "██╔══██╗██╔════╝╚██╗ ██╔╝████╗  ██║██╔═══██╗      ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██╔══██╗"
  Write-Host "███████║███████╗ ╚████╔╝ ██╔██╗ ██║██║   ██║█████╗███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ██║  ██║"
  Write-Host "██╔══██║╚════██║  ╚██╔╝  ██║╚██╗██║██║▄▄ ██║╚════╝██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ██║  ██║"
  Write-Host "██║  ██║███████║   ██║   ██║ ╚████║╚██████╔╝      ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ██████╔╝"
  Write-Host "╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═══╝ ╚══▀▀═╝       ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═════╝ "
  Write-Host ""
  Write-Host "Asynq Agentd v$Version"
  Write-Host "Autonomous agent daemon for Asynq Buddy"
  Write-Host "agentd.asynq.org"
  Write-Host ""
}

function Show-InstallNotes {
  Write-Host "Setup notes:"
  Write-Host "  Startup mode"
  Write-Host "    user  - recommended; start asynq-agentd automatically after login"
  Write-Host "    none  - install only; you will start asynq-agentd manually"
  Write-Host ""
  Write-Host "  Access mode"
  Write-Host "    tailscale - recommended; easiest secure Buddy access from your phone/laptop"
  Write-Host "    local     - only this computer can reach the daemon"
  Write-Host "    custom    - use your own domain, tunnel, or reverse proxy"
  Write-Host ""
}

function Get-TailscaleCommand {
  $direct = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($direct) {
    return $direct.Source
  }

  $candidates = @(
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    (Join-Path $HOME "Applications/Tailscale.app/Contents/MacOS/Tailscale"),
    (Join-Path $env:LOCALAPPDATA "Tailscale\tailscale.exe"),
    "C:\Program Files\Tailscale\tailscale.exe"
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }

  return $null
}

function Invoke-TailscaleStatusJson {
  param(
    [Parameter(Mandatory = $true)][string]$TailscaleCommand
  )

  $outputPath = [System.IO.Path]::GetTempFileName()
  try {
    $process = Start-Process -FilePath $TailscaleCommand -ArgumentList @("status", "--json") -NoNewWindow -RedirectStandardOutput $outputPath -PassThru
    if (-not $process.WaitForExit(3000)) {
      try {
        $process.Kill()
      } catch {
      }
      return $null
    }

    if ($process.ExitCode -ne 0) {
      return $null
    }

    return Get-Content $outputPath -Raw
  } finally {
    Remove-Item $outputPath -ErrorAction SilentlyContinue
  }
}

function Invoke-TailscaleCommandCapture {
  param(
    [Parameter(Mandatory = $true)][string]$TailscaleCommand,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  $stdoutPath = [System.IO.Path]::GetTempFileName()
  $stderrPath = [System.IO.Path]::GetTempFileName()
  try {
    $process = Start-Process -FilePath $TailscaleCommand -ArgumentList $Arguments -NoNewWindow -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
    if (-not $process.WaitForExit(15000)) {
      try {
        $process.Kill()
      } catch {
      }
    }

    return [pscustomobject]@{
      ExitCode = $process.ExitCode
      Stdout = (Get-Content $stdoutPath -Raw -ErrorAction SilentlyContinue)
      Stderr = (Get-Content $stderrPath -Raw -ErrorAction SilentlyContinue)
    }
  } finally {
    Remove-Item $stdoutPath -ErrorAction SilentlyContinue
    Remove-Item $stderrPath -ErrorAction SilentlyContinue
  }
}

function Prompt-Value {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string]$Default
  )

  if ($env:ASYNQ_AGENTD_NONINTERACTIVE -eq "1") {
    return $Default
  }

  $value = Read-Host "$Label [$Default]"
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $Default
  }

  return $value
}

function Prompt-Choice {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string]$Default,
    [Parameter(Mandatory = $true)][string[]]$Choices
  )

  $value = Prompt-Value -Label $Label -Default $Default
  if ($Choices -contains $value) {
    return $value
  }

  Write-Warning "Unsupported choice '$value', falling back to '$Default'"
  return $Default
}

function Wait-ForAuth {
  param(
    [Parameter(Mandatory = $true)][string]$AuthPath,
    [int]$TimeoutSeconds = 10
  )

  for ($i = 0; $i -lt $TimeoutSeconds; $i++) {
    if (Test-Path $AuthPath) {
      return $true
    }

    Start-Sleep -Seconds 1
  }

  return (Test-Path $AuthPath)
}

function Wait-ForTailscaleHost {
  param(
    [int]$TimeoutSeconds = 12
  )

  for ($i = 0; $i -lt $TimeoutSeconds; $i++) {
    $host = Get-TailscaleHost
    if ($host) {
      return $host
    }

    Start-Sleep -Seconds 1
  }

  return $null
}

function Get-TailscaleStatus {
  $tailscaleCommand = Get-TailscaleCommand
  if (-not $tailscaleCommand) {
    return "missing"
  }

  try {
    $statusJson = Invoke-TailscaleStatusJson -TailscaleCommand $tailscaleCommand
    if (-not $statusJson) {
      return "installed"
    }
    $status = $statusJson | ConvertFrom-Json
    $backendState = [string]$status.BackendState
    $dnsName = [string]$status.Self.DNSName
    $firstIp = if ($status.Self.TailscaleIPs.Count -gt 0) { [string]$status.Self.TailscaleIPs[0] } else { "" }
    if ($backendState -eq "NeedsLogin" -or $backendState -eq "NoState") {
      return "installed"
    }
    if ($dnsName -or $firstIp) {
      return "connected"
    }
  } catch {
    return "installed"
  }

  return "installed"
}

function Get-TailscaleHost {
  $tailscaleCommand = Get-TailscaleCommand
  if (-not $tailscaleCommand) {
    return $null
  }

  try {
    $statusJson = Invoke-TailscaleStatusJson -TailscaleCommand $tailscaleCommand
    if (-not $statusJson) {
      return $null
    }
    $status = $statusJson | ConvertFrom-Json
    if ($status.Self.DNSName) {
      return ($status.Self.DNSName -replace '\.$', '')
    }
    if ($status.Self.TailscaleIPs.Count -gt 0) {
      return [string]$status.Self.TailscaleIPs[0]
    }
  } catch {
    return $null
  }

  return $null
}

function Install-Tailscale {
  if (Get-TailscaleCommand) {
    return $true
  }

  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "Installing Tailscale with winget..."
    winget install --id Tailscale.Tailscale -e --accept-package-agreements --accept-source-agreements
    return [bool](Get-Command tailscale -ErrorAction SilentlyContinue)
  }

  Write-Warning "winget was not found. Install Tailscale from https://tailscale.com/download/windows and rerun this installer if needed."
  return $false
}

function Start-TailscaleRuntime {
  $appPaths = @(
    (Join-Path $env:LOCALAPPDATA "Tailscale\Tailscale.exe"),
    "C:\Program Files\Tailscale\tailscale-ipn.exe",
    "C:\Program Files\Tailscale\Tailscale.exe"
  )

  foreach ($appPath in $appPaths) {
    if (Test-Path $appPath) {
      try {
        Start-Process -FilePath $appPath | Out-Null
        Write-Host "Opened the Tailscale app. If Windows asks for VPN/network approval, allow it."
        Write-Host "If a Tailscale window appears, finish sign-in there or in the browser it opens."
        Start-Sleep -Seconds 2
        return $true
      } catch {
      }
    }
  }

  return $false
}

function Connect-Tailscale {
  $tailscaleCommand = Get-TailscaleCommand
  if (Get-TailscaleHost) {
    return $true
  }

  if (-not $tailscaleCommand) {
    return $false
  }

  [void](Start-TailscaleRuntime)
  Write-Host "Starting Tailscale login..."
  try {
    $result = Invoke-TailscaleCommandCapture -TailscaleCommand $tailscaleCommand -Arguments @("up")
    if ($result.Stdout) {
      Write-Host $result.Stdout.TrimEnd()
    }
    if ($result.Stderr) {
      Write-Warning $result.Stderr.TrimEnd()
    }
    if (($result.Stdout + $result.Stderr) -match "Failed to load preferences") {
      Write-Warning "Tailscale CLI is installed, but the app has not finished initializing yet."
      Write-Warning "Open the Tailscale app, complete sign-in, then rerun the installer or retry after a moment."
      return $false
    }
  } catch {
    Write-Warning "tailscale up failed. You may need to complete login manually."
  }

  $host = Wait-ForTailscaleHost
  if ($host) {
    Write-Host "Tailscale connected as $host"
    return $true
  }

  Write-Warning "Tailscale is installed but no tailnet hostname was detected yet."
  Write-Warning "Finish login in the Tailscale app or browser, then either rerun the installer or enter the final public URL manually."
  Write-Warning "Manual fallback steps:"
  Write-Warning "  1. Run 'tailscale up' in another terminal and complete login if prompted."
  Write-Warning "  2. Find your hostname with 'tailscale status' or 'tailscale status --json'."
  Write-Warning "  3. Enter a URL like 'http://your-mac.tailnet.ts.net:$Port' at the next prompt."
  return $false
}

function Ensure-TailscaleReady {
  param(
    [Parameter(Mandatory = $true)][string]$OnboardingMode
  )

  if (Get-TailscaleHost) {
    return $true
  }

  switch ($OnboardingMode) {
    "skip" {
      return $false
    }
    "manual" {
      Write-Host ""
      Write-Host "Tailscale onboarding was left in manual mode."
      Write-Host "Please install or sign in to Tailscale, then rerun the installer or update the public URL later."
      return $false
    }
    "auto" {
      if (-not (Install-Tailscale)) {
        return $false
      }
      return (Connect-Tailscale)
    }
    default {
      Write-Warning "Unsupported Tailscale onboarding mode '$OnboardingMode'"
      return $false
    }
  }
}

if (-not $SourceDir) {
  $SourceDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$workspaceVersion = Get-WorkspaceVersion -Root $SourceDir
Show-Banner -Version $workspaceVersion
Show-InstallNotes
if (-not $InstallDir) {
  $InstallDir = Prompt-Value -Label "Install wrapper binaries into" -Default (Join-Path $HOME ".local\bin")
}
if (-not $RuntimeHome) {
  $RuntimeHome = Prompt-Value -Label "Runtime home for asynq-agentd" -Default (Join-Path $HOME ".asynq-agentd")
}

$tailscaleHost = Get-TailscaleHost
$tailscaleStatus = Get-TailscaleStatus
if (-not $AccessMode) {
  $AccessMode = Prompt-Choice -Label "How should Buddy reach this daemon? (tailscale/local/custom)" -Default "tailscale" -Choices @("local", "tailscale", "custom")
}
if (-not $serviceModeProvided) {
  $ServiceMode = Prompt-Choice -Label "Start asynq-agentd automatically after login? (user/none)" -Default "user" -Choices @("none", "user")
}
if (-not $HostBind) {
  $HostBind = if ($AccessMode -eq "local") { "127.0.0.1" } else { "0.0.0.0" }
}
if (-not $portProvided) {
  $Port = Prompt-Value -Label "Daemon port" -Default "7433"
}
if ($AccessMode -eq "tailscale" -and -not $tailscaleHost) {
  $tailscaleOnboarding = Prompt-Choice -Label "Tailscale onboarding (auto/manual/skip)" -Default "auto" -Choices @("auto", "manual", "skip")
  [void](Ensure-TailscaleReady -OnboardingMode $tailscaleOnboarding)
  $tailscaleHost = Get-TailscaleHost
  $tailscaleStatus = Get-TailscaleStatus
}
if (-not $PublicUrl) {
  if ($AccessMode -eq "tailscale" -and $tailscaleHost) {
    $PublicUrl = "http://$tailscaleHost`:$Port"
  } elseif ($AccessMode -eq "tailscale") {
    Write-Host ""
    Write-Host "Tailscale is selected, but a tailnet hostname is not available yet."
    Write-Host "Before confirming the public URL, do one of these:"
    Write-Host "  1. In another terminal run: tailscale up"
    Write-Host "  2. Finish login in the Tailscale app/browser if it opened"
    Write-Host "  3. Then enter a URL like: http://your-mac.tailnet.ts.net:$Port"
    Write-Host ""
    $PublicUrl = "http://your-machine.tailnet.ts.net`:$Port"
  } else {
    $PublicUrl = "http://127.0.0.1`:$Port"
  }
  $PublicUrl = Prompt-Value -Label "Public daemon URL to embed in pairing QR" -Default $PublicUrl
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "node is required but was not found on PATH"
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  throw "pnpm is required but was not found on PATH"
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $RuntimeHome | Out-Null
$envFile = Join-Path $RuntimeHome "asynq-agentd.env.ps1"
$envCmdFile = Join-Path $RuntimeHome "asynq-agentd.env.cmd"

@"
$env:ASYNQ_AGENTD_HOME = "$RuntimeHome"
$env:ASYNQ_AGENTD_PUBLIC_URL = "$PublicUrl"
$env:HOST = "$HostBind"
$env:PORT = "$Port"
"@ | Set-Content -Path $envFile -Encoding ASCII

@"
@echo off
set ASYNQ_AGENTD_HOME=$RuntimeHome
set ASYNQ_AGENTD_PUBLIC_URL=$PublicUrl
set HOST=$HostBind
set PORT=$Port
"@ | Set-Content -Path $envCmdFile -Encoding ASCII

Push-Location $SourceDir
pnpm install
Pop-Location

$agentdCmd = Join-Path $InstallDir "asynq-agentd.cmd"
$agentctlCmd = Join-Path $InstallDir "asynq-agentctl.cmd"

@"
@echo off
if exist "$envCmdFile" call "$envCmdFile" >nul
set ASYNQ_AGENTD_HOME=%ASYNQ_AGENTD_HOME%
if "%ASYNQ_AGENTD_HOME%"=="" set ASYNQ_AGENTD_HOME=$RuntimeHome
set ASYNQ_AGENTD_PUBLIC_URL=%ASYNQ_AGENTD_PUBLIC_URL%
if "%ASYNQ_AGENTD_PUBLIC_URL%"=="" set ASYNQ_AGENTD_PUBLIC_URL=$PublicUrl
set HOST=%HOST%
if "%HOST%"=="" set HOST=$HostBind
set PORT=%PORT%
if "%PORT%"=="" set PORT=$Port
node "$SourceDir\apps\asynq-agentd\src\index.ts" %*
"@ | Set-Content -Path $agentdCmd -Encoding ASCII

@"
@echo off
if exist "$envCmdFile" call "$envCmdFile" >nul
set ASYNQ_AGENTD_HOME=%ASYNQ_AGENTD_HOME%
if "%ASYNQ_AGENTD_HOME%"=="" set ASYNQ_AGENTD_HOME=$RuntimeHome
set ASYNQ_AGENTD_PUBLIC_URL=%ASYNQ_AGENTD_PUBLIC_URL%
if "%ASYNQ_AGENTD_PUBLIC_URL%"=="" set ASYNQ_AGENTD_PUBLIC_URL=$PublicUrl
set HOST=%HOST%
if "%HOST%"=="" set HOST=$HostBind
set PORT=%PORT%
if "%PORT%"=="" set PORT=$Port
node "$SourceDir\apps\asynq-agentctl\src\index.ts" %*
"@ | Set-Content -Path $agentctlCmd -Encoding ASCII

$serviceStatus = "not installed"
if ($ServiceMode -eq "user") {
  $taskName = "asynq-agentd"
  schtasks /Create /F /SC ONLOGON /RL LIMITED /TN $taskName /TR "`"$agentdCmd`"" | Out-Null
  $serviceStatus = "scheduled task '$taskName' created"
}

$speechSetupStatus = "skipped by installer flag"
if (-not $SkipSpeechSetup) {
  try {
    & $agentctlCmd speech setup --install-model --restart | Out-Null
    $speechSetupStatus = "whisper model configured"
  } catch {
    $speechSetupStatus = "speech setup skipped after a non-fatal error; run '$agentctlCmd speech setup --install-model --restart' later"
  }
}

Write-Host ""
Write-Host "asynq-agentd install complete"
Write-Host "source dir: $SourceDir"
Write-Host "install dir: $InstallDir"
Write-Host "runtime home: $RuntimeHome"
Write-Host "env file: $envFile"
Write-Host "cmd env file: $envCmdFile"
Write-Host "service: $serviceStatus"
Write-Host "speech: $speechSetupStatus"
Write-Host "access mode: $AccessMode"
if ($AccessMode -eq "tailscale") {
  Write-Host "tailscale status: $tailscaleStatus"
  if ($tailscaleHost) {
    Write-Host "tailscale host: $tailscaleHost"
  }
}
Write-Host "bind host: $HostBind"
Write-Host "public url: $PublicUrl"
Write-Host "binaries:"
Write-Host "  $agentdCmd"
Write-Host "  $agentctlCmd"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Add $InstallDir to PATH if needed"
Write-Host "  2. Start with: $agentdCmd"
Write-Host "  3. Check auth token at: $(Join-Path $RuntimeHome 'auth.json')"
Write-Host "  4. Run: $agentctlCmd status"
if ($AccessMode -eq "tailscale" -and -not $tailscaleHost) {
  Write-Host "  5. Finish Tailscale install/login, then update $envFile if the final MagicDNS name differs"
}

$authPath = Join-Path $RuntimeHome "auth.json"
if ($ServiceMode -eq "user" -and (Wait-ForAuth -AuthPath $authPath -TimeoutSeconds 10)) {
  Write-Host ""
  Write-Host "Daemon auth token detected. Pairing is ready (opening browser QR):"
  & $agentctlCmd pairing --open-qr --no-qr --public-url $PublicUrl
} elseif (Test-Path $authPath) {
  Write-Host ""
  $printPairing = Read-Host "Print pairing URI and open browser QR now? [Y/n]"
  if ([string]::IsNullOrWhiteSpace($printPairing) -or $printPairing -match '^(y|yes)$') {
    & $agentctlCmd pairing --open-qr --no-qr --public-url $PublicUrl
  }
} else {
  Write-Host ""
  Write-Host "Pairing QR is not ready yet because auth.json does not exist."
  Write-Host "After the daemon starts and creates $authPath, run:"
  Write-Host "  $agentctlCmd pairing --open-qr --no-qr --public-url $PublicUrl"
}
