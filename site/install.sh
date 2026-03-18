#!/bin/sh
set -eu

REPO_URL="${ASYNQ_AGENTD_REPO_URL:-https://github.com/asynq-org/asynq-agentd.git}"
REF="${ASYNQ_AGENTD_REF:-main}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "asynq-agentd installer requires '$1'." >&2
    exit 1
  fi
}

need_cmd git

if command -v mktemp >/dev/null 2>&1; then
  TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t asynq-agentd)"
else
  TMP_DIR="/tmp/asynq-agentd-install-$$"
  mkdir -p "$TMP_DIR"
fi

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

echo "asynq-agentd hosted installer"
echo "Cloning ${REPO_URL} (${REF}) into a temporary directory..."

git clone --depth 1 --branch "$REF" "$REPO_URL" "$TMP_DIR/repo"

cd "$TMP_DIR/repo"
exec sh ./scripts/install.sh "$@"
