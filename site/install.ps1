$ErrorActionPreference = "Stop"

$RepoUrl = if ($env:ASYNQ_AGENTD_REPO_URL) { $env:ASYNQ_AGENTD_REPO_URL } else { "https://github.com/asynq-org/asynq-agentd.git" }
$Ref = if ($env:ASYNQ_AGENTD_REF) { $env:ASYNQ_AGENTD_REF } else { "main" }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "asynq-agentd installer requires 'git'."
}

$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("asynq-agentd-install-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $TempRoot | Out-Null

try {
  Write-Host "asynq-agentd hosted installer"
  Write-Host "Cloning $RepoUrl ($Ref) into a temporary directory..."

  git clone --depth 1 --branch $Ref $RepoUrl (Join-Path $TempRoot "repo")

  Set-Location (Join-Path $TempRoot "repo")
  & powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 @args
}
finally {
  Remove-Item -Recurse -Force $TempRoot -ErrorAction SilentlyContinue
}
