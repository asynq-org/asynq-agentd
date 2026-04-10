#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=${ASYNQ_AGENTD_SOURCE_DIR:-$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)}
INSTALL_DIR_DEFAULT="${HOME}/.local/bin"
RUNTIME_HOME_DEFAULT="${HOME}/.asynq-agentd"
SERVICE_CHOICE_DEFAULT="user"
PUBLIC_URL_DEFAULT="http://127.0.0.1:7433"
HOST_BIND_DEFAULT="127.0.0.1"
PORT_DEFAULT="7433"
ACCESS_MODE_DEFAULT="tailscale"
TAILSCALE_ONBOARDING_DEFAULT="auto"
REUSE_CONFIG=0
SKIP_PAIRING=0

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required but was not found on PATH" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "error: pnpm is required but was not found on PATH" >&2
  exit 1
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --reuse-config)
      REUSE_CONFIG=1
      ;;
    --non-interactive)
      ASYNQ_AGENTD_NONINTERACTIVE=1
      export ASYNQ_AGENTD_NONINTERACTIVE
      ;;
    --skip-pairing)
      SKIP_PAIRING=1
      ;;
    --install-dir)
      shift
      [ "$#" -gt 0 ] || { echo "error: --install-dir requires a value" >&2; exit 1; }
      INSTALL_DIR_DEFAULT=$1
      ;;
    --runtime-home)
      shift
      [ "$#" -gt 0 ] || { echo "error: --runtime-home requires a value" >&2; exit 1; }
      RUNTIME_HOME_DEFAULT=$1
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      echo "usage: ./scripts/install.sh [--reuse-config] [--non-interactive] [--skip-pairing] [--install-dir <path>] [--runtime-home <path>]" >&2
      exit 1
      ;;
  esac
  shift
done

read_workspace_version() {
  node -e '
    const fs = require("fs");
    const path = require("path");
    const pkg = JSON.parse(fs.readFileSync(path.join(process.argv[1], "package.json"), "utf8"));
    process.stdout.write(typeof pkg.version === "string" && pkg.version ? pkg.version : "dev");
  ' "$REPO_ROOT" 2>/dev/null || printf 'dev'
}

print_banner() {
  version=$1
  cat <<EOF

   █████╗ ███████╗██╗   ██╗███╗   ██╗ ██████╗        █████╗  ██████╗ ███████╗███╗   ██╗████████╗██████╗
  ██╔══██╗██╔════╝╚██╗ ██╔╝████╗  ██║██╔═══██╗      ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██╔══██╗
  ███████║███████╗ ╚████╔╝ ██╔██╗ ██║██║   ██║█████╗███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ██║  ██║
  ██╔══██║╚════██║  ╚██╔╝  ██║╚██╗██║██║▄▄ ██║╚════╝██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ██║  ██║
  ██║  ██║███████║   ██║   ██║ ╚████║╚██████╔╝      ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ██████╔╝
  ╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═══╝ ╚══▀▀═╝       ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═════╝

  Asynq Agentd v$version
  Autonomous agent daemon for Asynq Buddy
  agentd.asynq.org

EOF
}

print_install_notes() {
  cat <<EOF
Setup notes:
  Startup mode
    user  - recommended; start asynq-agentd automatically after login
    none  - install only; you will start asynq-agentd manually

  Access mode
    tailscale - recommended; easiest secure Buddy access from your phone/laptop
    local     - only this Mac can reach the daemon
    custom    - use your own domain, tunnel, or reverse proxy

EOF
}

resolve_tailscale_bin() {
  if command -v tailscale >/dev/null 2>&1; then
    command -v tailscale
    return 0
  fi

  for candidate in \
    "/opt/homebrew/bin/tailscale" \
    "/usr/local/bin/tailscale" \
    "/opt/homebrew/opt/tailscale/bin/tailscale" \
    "/usr/local/opt/tailscale/bin/tailscale" \
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale" \
    "${HOME}/Applications/Tailscale.app/Contents/MacOS/Tailscale"
  do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done

  return 1
}

run_tailscale_status_json() {
  tailscale_bin=$1
  node -e '
    const { execFile } = require("node:child_process");
    const bin = process.argv[1];
    execFile(bin, ["status", "--json"], { timeout: 3000 }, (error, stdout) => {
      if (error) {
        process.exit(1);
      }
      process.stdout.write(stdout);
    });
  ' "$tailscale_bin" 2>/dev/null || return 1
}

run_tailscale_capture() {
  tailscale_bin=$1
  shift
  node -e '
    const { execFile } = require("node:child_process");
    const [bin, ...args] = process.argv.slice(1);
    execFile(bin, args, { timeout: 15000 }, (error, stdout, stderr) => {
      process.stdout.write(stdout || "");
      process.stderr.write(stderr || "");
      if (error) process.exit(typeof error.code === "number" ? error.code : 1);
    });
  ' "$tailscale_bin" "$@" || return 1
}

prompt() {
  label=$1
  default_value=$2
  if [ "${ASYNQ_AGENTD_NONINTERACTIVE:-0}" = "1" ] || [ ! -t 0 ]; then
    printf '%s' "$default_value"
    return
  fi

  printf "%s [%s]: " "$label" "$default_value" >&2
  read -r value || true
  if [ -z "${value:-}" ]; then
    printf '%s' "$default_value"
  else
    printf '%s' "$value"
  fi
}

prompt_choice() {
  label=$1
  default_value=$2
  allowed_values=$3
  value=$(prompt "$label" "$default_value")
  for allowed in $allowed_values; do
    if [ "$value" = "$allowed" ]; then
      printf '%s' "$value"
      return
    fi
  done

  echo "warning: unsupported choice '$value', falling back to '$default_value'" >&2
  printf '%s' "$default_value"
}

confirm() {
  label=$1
  default_value=$2
  if [ "${ASYNQ_AGENTD_NONINTERACTIVE:-0}" = "1" ] || [ ! -t 0 ]; then
    [ "$default_value" = "yes" ] && return 0 || return 1
  fi

  if [ "$default_value" = "yes" ]; then
    suffix="Y/n"
  else
    suffix="y/N"
  fi

  printf "%s [%s]: " "$label" "$suffix" >&2
  read -r value || true
  case "${value:-}" in
    y|Y|yes|YES) return 0 ;;
    n|N|no|NO) return 1 ;;
    "")
      [ "$default_value" = "yes" ] && return 0 || return 1
      ;;
    *)
      [ "$default_value" = "yes" ] && return 0 || return 1
      ;;
  esac
}

run_with_optional_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
    return
  fi

  echo "warning: sudo is required for this step but was not found" >&2
  return 1
}

wait_for_auth() {
  auth_path=$1
  timeout_seconds=$2
  elapsed=0

  while [ "$elapsed" -lt "$timeout_seconds" ]; do
    if [ -f "$auth_path" ]; then
      return 0
    fi

    sleep 1
    elapsed=$((elapsed + 1))
  done

  return 1
}

wait_for_tailscale_host() {
  timeout_seconds=$1
  elapsed=0

  while [ "$elapsed" -lt "$timeout_seconds" ]; do
    host=$(detect_tailscale_host || true)
    if [ -n "${host:-}" ]; then
      printf '%s' "$host"
      return 0
    fi

    sleep 1
    elapsed=$((elapsed + 1))
  done

  return 1
}

detect_tailscale_status() {
  tailscale_bin=$(resolve_tailscale_bin || true)
  if [ -z "${tailscale_bin:-}" ]; then
    printf 'missing'
    return
  fi

  status_json=$(run_tailscale_status_json "$tailscale_bin" || true)
  if [ -z "${status_json:-}" ]; then
    printf 'installed'
    return
  fi

  printf '%s' "$status_json" | node -e '
    const fs = require("fs");
    const input = fs.readFileSync(0, "utf8");
    if (!input.trim()) {
      process.stdout.write("installed");
      process.exit(0);
    }
    const data = JSON.parse(input);
    const backendState = typeof data.BackendState === "string" ? data.BackendState : "";
    const self = data.Self || {};
    const loggedOut = backendState === "NeedsLogin" || backendState === "NoState";
    const host =
      (typeof self.DNSName === "string" && self.DNSName.replace(/\.$/, "")) ||
      (Array.isArray(self.TailscaleIPs) && self.TailscaleIPs.length > 0 ? String(self.TailscaleIPs[0]) : "");
    process.stdout.write(loggedOut ? "installed" : host ? "connected" : "installed");
  ' 2>/dev/null
}

detect_tailscale_host() {
  tailscale_bin=$(resolve_tailscale_bin || true)
  if [ -z "${tailscale_bin:-}" ]; then
    return 1
  fi

  status_json=$(run_tailscale_status_json "$tailscale_bin" || true)
  if [ -z "${status_json:-}" ]; then
    return 1
  fi

  printf '%s' "$status_json" | node -e '
    const fs = require("fs");
    const input = fs.readFileSync(0, "utf8");
    if (!input.trim()) process.exit(1);
    const data = JSON.parse(input);
    const self = data.Self || {};
    const dnsName = typeof self.DNSName === "string" ? self.DNSName.replace(/\.$/, "") : "";
    const ip = Array.isArray(self.TailscaleIPs) && self.TailscaleIPs.length > 0 ? String(self.TailscaleIPs[0]) : "";
    const host = dnsName || ip;
    if (!host) process.exit(1);
    process.stdout.write(host);
  ' 2>/dev/null
}

install_tailscale() {
  uname_s=$(uname -s)

  if [ "$uname_s" = "Darwin" ] && command -v tailscale >/dev/null 2>&1; then
    return 0
  fi

  if [ "$uname_s" != "Darwin" ] && resolve_tailscale_bin >/dev/null 2>&1; then
    return 0
  fi

  if [ "$uname_s" = "Darwin" ]; then
    if command -v brew >/dev/null 2>&1; then
      echo "Installing Tailscale CLI and daemon with Homebrew..."
      brew install tailscale
      brew services start tailscale >/dev/null 2>&1 || true
      return
    fi

    echo "warning: Homebrew was not found. Install Tailscale CLI from https://tailscale.com/download/mac and rerun this installer if needed." >&2
    return 1
  fi

  if [ "$uname_s" = "Linux" ]; then
    if ! command -v curl >/dev/null 2>&1; then
      echo "warning: curl is required for automatic Tailscale install on Linux" >&2
      return 1
    fi

    echo "Installing Tailscale using the official install script..."
    if [ "$(id -u)" -eq 0 ]; then
      curl -fsSL https://tailscale.com/install.sh | sh
      return
    fi

    if command -v sudo >/dev/null 2>&1; then
      curl -fsSL https://tailscale.com/install.sh | sudo sh
      return
    fi

    echo "warning: sudo is required for automatic Tailscale install on Linux" >&2
    return 1
  fi

  echo "warning: automatic Tailscale install is not supported on this platform" >&2
  return 1
}

start_tailscale_runtime() {
  uname_s=$(uname -s)

  if [ "$uname_s" = "Darwin" ]; then
    ensure_tailscale_daemon || true
    echo "Prepared Tailscale CLI on macOS." >&2
    echo "If macOS asks to allow a VPN or background service, approve it." >&2
    sleep 2
    return 0
  fi

  if [ "$uname_s" = "Linux" ]; then
    if command -v systemctl >/dev/null 2>&1; then
      run_with_optional_sudo systemctl enable --now tailscaled >/dev/null 2>&1 || true
    fi
    return 0
  fi

  return 0
}

tailscale_service_running() {
  uname_s=$(uname -s)

  if [ "$uname_s" = "Darwin" ]; then
    [ -S /var/run/tailscaled.socket ] && return 0 || return 1
  fi

  if ! command -v brew >/dev/null 2>&1; then
    return 1
  fi

  service_info=$(brew services info tailscale 2>/dev/null || true)
  case "$service_info" in
    *"Running: true"*) return 0 ;;
    *) return 1 ;;
  esac
}

ensure_tailscale_daemon() {
  uname_s=$(uname -s)

  if [ "$uname_s" = "Darwin" ]; then
    if ! command -v brew >/dev/null 2>&1; then
      return 1
    fi

    if tailscale_service_running; then
      return 0
    fi

    echo "Ensuring Tailscale daemon is running via Homebrew services..." >&2
    brew services stop tailscale >/dev/null 2>&1 || true
    run_with_optional_sudo brew services stop tailscale >/dev/null 2>&1 || true
    run_with_optional_sudo brew services start tailscale >/dev/null 2>&1 || true
    sleep 2
    if tailscale_service_running; then
      return 0
    fi

    run_with_optional_sudo brew services restart tailscale >/dev/null 2>&1 || true
    sleep 2
    if tailscale_service_running; then
      return 0
    fi

    brew services cleanup >/dev/null 2>&1 || true
    run_with_optional_sudo brew services cleanup >/dev/null 2>&1 || true
    run_with_optional_sudo brew services start tailscale >/dev/null 2>&1 || true
    sleep 2
    if tailscale_service_running; then
      return 0
    fi

    echo "warning: Homebrew could not get the Tailscale daemon into a running state." >&2
    echo "warning: Try 'sudo brew services restart tailscale' and inspect 'sudo brew services info tailscale'." >&2
    return 1
  fi

  if [ "$uname_s" = "Linux" ]; then
    if command -v systemctl >/dev/null 2>&1; then
      run_with_optional_sudo systemctl enable --now tailscaled >/dev/null 2>&1 || true
    fi
    return 0
  fi

  return 1
}

connect_tailscale() {
  uname_s=$(uname -s)
  tailscale_bin=$(resolve_tailscale_bin || true)

  if [ -n "$(detect_tailscale_host || true)" ]; then
    return 0
  fi

  if [ -z "${tailscale_bin:-}" ]; then
    return 1
  fi

  start_tailscale_runtime || true

  echo "Starting Tailscale login..."
  if [ "$uname_s" = "Linux" ]; then
    run_with_optional_sudo "$tailscale_bin" up || true
  else
    tailscale_output=$(run_tailscale_capture "$tailscale_bin" up 2>&1 || true)
    if [ -n "${tailscale_output:-}" ]; then
      printf '%s\n' "$tailscale_output" >&2
    fi
    case "${tailscale_output:-}" in
      *"failed to connect to local Tailscale service; is Tailscale running?"*)
        if ensure_tailscale_daemon; then
          echo "Retrying Tailscale login after starting the daemon..." >&2
          tailscale_output=$(run_tailscale_capture "$tailscale_bin" up 2>&1 || true)
          if [ -n "${tailscale_output:-}" ]; then
            printf '%s\n' "$tailscale_output" >&2
          fi
        fi
        ;;
      *"Failed to load preferences."*)
        echo "warning: Tailscale CLI is installed, but local preferences are not ready yet." >&2
        echo "warning: On macOS, try running 'brew services restart tailscale' and then '$tailscale_bin up' manually." >&2
        return 1
        ;;
    esac
  fi

  if host=$(wait_for_tailscale_host 12); then
    printf '%s\n' "Tailscale connected as $host"
    return 0
  fi

  echo "warning: Tailscale is installed but no tailnet hostname was detected yet." >&2
  echo "warning: Finish login in the browser opened by '$tailscale_bin up', then either rerun the installer or enter the final public URL manually." >&2
  echo "warning: Manual fallback steps:" >&2
  echo "warning:   1. Run '$tailscale_bin up' in another terminal and complete login if prompted." >&2
  echo "warning:   2. Find your hostname with '$tailscale_bin status' or '$tailscale_bin status --json'." >&2
  echo "warning:   3. Enter a URL like 'http://your-mac.tailnet.ts.net:$PORT' at the next prompt." >&2
  return 1
}

ensure_tailscale_ready() {
  onboarding_mode=$1

  if [ -n "$(detect_tailscale_host || true)" ]; then
    return 0
  fi

  case "$onboarding_mode" in
    skip)
      return 1
      ;;
    manual)
      echo
      echo "Tailscale onboarding was left in manual mode."
      echo "Please install or sign in to Tailscale, then rerun the installer or update the public URL later."
      return 1
      ;;
    auto)
      if ! resolve_tailscale_bin >/dev/null 2>&1; then
        install_tailscale || return 1
      fi
      connect_tailscale || return 1
      return 0
      ;;
    *)
      echo "warning: unsupported Tailscale onboarding mode: $onboarding_mode" >&2
      return 1
      ;;
  esac
}

detect_service_choice_default() {
  uname_s=$(uname -s)
  if [ "$uname_s" = "Darwin" ] && [ -f "${HOME}/Library/LaunchAgents/org.asynq.asynq-agentd.plist" ]; then
    printf 'user'
    return
  fi

  if [ "$uname_s" = "Linux" ] && [ -f "${HOME}/.config/systemd/user/asynq-agentd.service" ]; then
    printf 'user'
    return
  fi

  printf 'none'
}

infer_access_mode_from_config() {
  host=$1
  public_url=$2

  if [ "$host" = "127.0.0.1" ]; then
    printf 'local'
    return
  fi

  case "$public_url" in
    *".ts.net:"*|*"tail"*".ts.net:"*)
      printf 'tailscale'
      return
      ;;
    *)
      printf 'custom'
      return
      ;;
  esac
}

if command -v asynq-agentd >/dev/null 2>&1; then
  detected_install_dir=$(dirname "$(command -v asynq-agentd)")
  if [ -n "${detected_install_dir:-}" ]; then
    INSTALL_DIR_DEFAULT=$detected_install_dir
  fi
fi

if [ "$REUSE_CONFIG" = "1" ]; then
  existing_env_file=""
  for candidate in \
    "${ASYNQ_AGENTD_ENV_FILE:-}" \
    "$RUNTIME_HOME_DEFAULT/asynq-agentd.env" \
    "${HOME}/.asynq-agentd/asynq-agentd.env"
  do
    if [ -n "${candidate:-}" ] && [ -f "$candidate" ]; then
      existing_env_file=$candidate
      break
    fi
  done

  if [ -n "${existing_env_file:-}" ]; then
    # shellcheck disable=SC1090
    . "$existing_env_file"
    RUNTIME_HOME_DEFAULT=${ASYNQ_AGENTD_HOME:-$RUNTIME_HOME_DEFAULT}
    PUBLIC_URL_DEFAULT=${ASYNQ_AGENTD_PUBLIC_URL:-$PUBLIC_URL_DEFAULT}
    HOST_BIND_DEFAULT=${HOST:-$HOST_BIND_DEFAULT}
    PORT_DEFAULT=${PORT:-$PORT_DEFAULT}
    ACCESS_MODE_DEFAULT=$(infer_access_mode_from_config "$HOST_BIND_DEFAULT" "$PUBLIC_URL_DEFAULT")
  fi

  SERVICE_CHOICE_DEFAULT=$(detect_service_choice_default)
  TAILSCALE_ONBOARDING_DEFAULT="skip"
  if [ "${ASYNQ_AGENTD_NONINTERACTIVE:-0}" = "1" ]; then
    SKIP_PAIRING=1
  fi
fi

TAILSCALE_HOST=$(detect_tailscale_host || true)

WORKSPACE_VERSION=$(read_workspace_version)
print_banner "$WORKSPACE_VERSION"
print_install_notes

INSTALL_DIR=$(prompt "Install wrapper binaries into" "$INSTALL_DIR_DEFAULT")
RUNTIME_HOME=$(prompt "Runtime home for asynq-agentd" "$RUNTIME_HOME_DEFAULT")
SERVICE_CHOICE=$(prompt_choice "Start asynq-agentd automatically after login? (user/none)" "$SERVICE_CHOICE_DEFAULT" "none user")
PORT=$(prompt "Daemon port" "$PORT_DEFAULT")
ACCESS_MODE=$(prompt_choice "How should Buddy reach this daemon? (tailscale/local/custom)" "$ACCESS_MODE_DEFAULT" "local tailscale custom")

case "$ACCESS_MODE" in
  local)
    HOST_BIND="127.0.0.1"
    PUBLIC_URL_DEFAULT="http://127.0.0.1:$PORT"
    ;;
  tailscale)
    HOST_BIND="0.0.0.0"
    if [ -n "${TAILSCALE_HOST:-}" ]; then
      PUBLIC_URL_DEFAULT="http://$TAILSCALE_HOST:$PORT"
    else
      PUBLIC_URL_DEFAULT="http://your-machine.tailnet.ts.net:$PORT"
    fi
    ;;
  custom)
    HOST_BIND="0.0.0.0"
    ;;
  *)
    echo "error: unsupported access mode: $ACCESS_MODE" >&2
    exit 1
    ;;
esac

TAILSCALE_STATUS=$(detect_tailscale_status)
TAILSCALE_ONBOARDING="skip"
if [ "$ACCESS_MODE" = "tailscale" ]; then
  case "$TAILSCALE_STATUS" in
    connected)
      echo "Tailscale is already connected as ${TAILSCALE_HOST:-unknown-host}" >&2
      ;;
    installed)
      TAILSCALE_ONBOARDING=$(prompt_choice "Tailscale onboarding (auto/manual/skip)" "$TAILSCALE_ONBOARDING_DEFAULT" "auto manual skip")
      ensure_tailscale_ready "$TAILSCALE_ONBOARDING" || true
      TAILSCALE_HOST=$(detect_tailscale_host || true)
      TAILSCALE_STATUS=$(detect_tailscale_status)
      ;;
    missing)
      TAILSCALE_ONBOARDING=$(prompt_choice "Tailscale onboarding (auto/manual/skip)" "$TAILSCALE_ONBOARDING_DEFAULT" "auto manual skip")
      ensure_tailscale_ready "$TAILSCALE_ONBOARDING" || true
      TAILSCALE_HOST=$(detect_tailscale_host || true)
      TAILSCALE_STATUS=$(detect_tailscale_status)
      ;;
  esac

  if [ -n "${TAILSCALE_HOST:-}" ]; then
    PUBLIC_URL_DEFAULT="http://$TAILSCALE_HOST:$PORT"
  else
    tailscale_bin=$(resolve_tailscale_bin || printf 'tailscale')
    echo >&2
    echo "Tailscale is selected, but a tailnet hostname is not available yet." >&2
    echo "Before confirming the public URL, do one of these:" >&2
    echo "  1. In another terminal run: $tailscale_bin up" >&2
    echo "  2. Complete login in the browser that command opens" >&2
    echo "  3. Then enter a URL like: http://your-mac.tailnet.ts.net:$PORT" >&2
    echo >&2
  fi
fi

PUBLIC_URL=$(prompt "Public daemon URL to embed in pairing QR" "$PUBLIC_URL_DEFAULT")

mkdir -p "$INSTALL_DIR" "$RUNTIME_HOME"

ENV_FILE="$RUNTIME_HOME/asynq-agentd.env"
cat >"$ENV_FILE" <<EOF
ASYNQ_AGENTD_HOME=$RUNTIME_HOME
ASYNQ_AGENTD_PUBLIC_URL=$PUBLIC_URL
HOST=$HOST_BIND
PORT=$PORT
EOF

echo "Installing pnpm dependencies in $REPO_ROOT"
(
  cd "$REPO_ROOT"
  pnpm install
)

cat >"$INSTALL_DIR/asynq-agentd" <<EOF
#!/bin/sh
set -eu
ENV_FILE="\${ASYNQ_AGENTD_ENV_FILE:-$ENV_FILE}"
[ -f "\$ENV_FILE" ] && . "\$ENV_FILE"
export ASYNQ_AGENTD_HOME="\${ASYNQ_AGENTD_HOME:-$RUNTIME_HOME}"
export ASYNQ_AGENTD_PUBLIC_URL="\${ASYNQ_AGENTD_PUBLIC_URL:-$PUBLIC_URL}"
export HOST="\${HOST:-$HOST_BIND}"
export PORT="\${PORT:-$PORT}"
exec node "$REPO_ROOT/apps/asynq-agentd/src/index.ts" "\$@"
EOF
chmod +x "$INSTALL_DIR/asynq-agentd"

cat >"$INSTALL_DIR/asynq-agentctl" <<EOF
#!/bin/sh
set -eu
ENV_FILE="\${ASYNQ_AGENTD_ENV_FILE:-$ENV_FILE}"
[ -f "\$ENV_FILE" ] && . "\$ENV_FILE"
export ASYNQ_AGENTD_HOME="\${ASYNQ_AGENTD_HOME:-$RUNTIME_HOME}"
export ASYNQ_AGENTD_PUBLIC_URL="\${ASYNQ_AGENTD_PUBLIC_URL:-$PUBLIC_URL}"
export HOST="\${HOST:-$HOST_BIND}"
export PORT="\${PORT:-$PORT}"
exec node "$REPO_ROOT/apps/asynq-agentctl/src/index.ts" "\$@"
EOF
chmod +x "$INSTALL_DIR/asynq-agentctl"

SERVICE_STATUS="not installed"
UNAME_S=$(uname -s)

if [ "$SERVICE_CHOICE" = "user" ]; then
  if [ "$UNAME_S" = "Darwin" ]; then
    PLIST_PATH="${HOME}/Library/LaunchAgents/org.asynq.asynq-agentd.plist"
    mkdir -p "$(dirname "$PLIST_PATH")"
    cat >"$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>org.asynq.asynq-agentd</string>
    <key>ProgramArguments</key>
    <array>
      <string>$INSTALL_DIR/asynq-agentd</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>ASYNQ_AGENTD_HOME</key>
      <string>$RUNTIME_HOME</string>
      <key>ASYNQ_AGENTD_PUBLIC_URL</key>
      <string>$PUBLIC_URL</string>
      <key>HOST</key>
      <string>$HOST_BIND</string>
      <key>PORT</key>
      <string>$PORT</string>
      <key>PATH</key>
      <string>$PATH</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>$REPO_ROOT</string>
    <key>StandardOutPath</key>
    <string>$RUNTIME_HOME/asynq-agentd.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$RUNTIME_HOME/asynq-agentd.stderr.log</string>
  </dict>
</plist>
EOF
    launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
    launchctl load "$PLIST_PATH"
    SERVICE_STATUS="launchd user agent installed at $PLIST_PATH"
  elif [ "$UNAME_S" = "Linux" ]; then
    UNIT_PATH="${HOME}/.config/systemd/user/asynq-agentd.service"
    mkdir -p "$(dirname "$UNIT_PATH")"
    cat >"$UNIT_PATH" <<EOF
[Unit]
Description=asynq-agentd user service
After=default.target

[Service]
Type=simple
Environment=ASYNQ_AGENTD_HOME=$RUNTIME_HOME
Environment=ASYNQ_AGENTD_PUBLIC_URL=$PUBLIC_URL
Environment=HOST=$HOST_BIND
Environment=PORT=$PORT
WorkingDirectory=$REPO_ROOT
ExecStart=$INSTALL_DIR/asynq-agentd
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now asynq-agentd.service
    SERVICE_STATUS="systemd user service installed at $UNIT_PATH"
  else
    SERVICE_STATUS="unsupported service platform: $UNAME_S"
  fi
fi

AUTH_HINT="$RUNTIME_HOME/auth.json"

echo
echo "asynq-agentd install complete"
echo "repo root: $REPO_ROOT"
echo "install dir: $INSTALL_DIR"
echo "runtime home: $RUNTIME_HOME"
echo "env file: $ENV_FILE"
echo "service: $SERVICE_STATUS"
echo "access mode: $ACCESS_MODE"
if [ "$ACCESS_MODE" = "tailscale" ]; then
  echo "tailscale status: $TAILSCALE_STATUS"
  if [ -n "${TAILSCALE_HOST:-}" ]; then
    echo "tailscale host: $TAILSCALE_HOST"
  fi
fi
echo "bind host: $HOST_BIND"
echo "public url: $PUBLIC_URL"
echo "binaries:"
echo "  $INSTALL_DIR/asynq-agentd"
echo "  $INSTALL_DIR/asynq-agentctl"
echo
echo "Next steps:"
echo "  1. Ensure $INSTALL_DIR is on PATH"
echo "  2. Verify the daemon with: $INSTALL_DIR/asynq-agentctl status"
echo "  3. If needed, inspect auth token at: $AUTH_HINT"
echo "  4. For now, use the local CLI and API in this repo. Buddy web/mobile UI is not included here yet."
echo "  5. When Buddy UI is available, use the pairing link or QR code shown below to connect it."
if [ "$ACCESS_MODE" = "tailscale" ] && [ -z "${TAILSCALE_HOST:-}" ]; then
  echo "  6. Finish Tailscale login, then update $ENV_FILE if the final MagicDNS name differs"
fi
if [ "$SKIP_PAIRING" != "1" ]; then
  if [ "$SERVICE_CHOICE" = "user" ] && wait_for_auth "$AUTH_HINT" 10; then
    echo
    echo "Daemon auth token detected. Pairing is ready:"
    "$INSTALL_DIR/asynq-agentctl" pairing --qr --public-url "$PUBLIC_URL"
  elif [ -f "$AUTH_HINT" ]; then
    if confirm "Print pairing URI and terminal QR now?" "yes"; then
      echo
      "$INSTALL_DIR/asynq-agentctl" pairing --qr --public-url "$PUBLIC_URL"
    fi
  else
    echo
    echo "Pairing QR is not ready yet because auth.json does not exist."
    echo "After the daemon starts and creates $AUTH_HINT, run:"
    echo "  $INSTALL_DIR/asynq-agentctl pairing --qr --public-url $PUBLIC_URL"
  fi
fi
