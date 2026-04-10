#!/bin/sh
set -eu

REPO_URL="${ASYNQ_AGENTD_REPO_URL:-https://github.com/asynq-org/asynq-agentd.git}"
REF="${ASYNQ_AGENTD_REF:-main}"
CHECKOUT_DIR="${ASYNQ_AGENTD_SOURCE_DIR:-${HOME}/.asynq-agentd/source}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "asynq-agentd installer requires '$1'." >&2
    exit 1
  fi
}

need_cmd git

echo "asynq-agentd hosted installer"
echo "Preparing source checkout in ${CHECKOUT_DIR} (${REF})..."

mkdir -p "$(dirname "$CHECKOUT_DIR")"
if [ -d "$CHECKOUT_DIR/.git" ]; then
  echo "Updating existing checkout..."
  git -C "$CHECKOUT_DIR" fetch --depth 1 origin "$REF"
  git -C "$CHECKOUT_DIR" checkout -f FETCH_HEAD
  git -C "$CHECKOUT_DIR" reset --hard FETCH_HEAD
else
  rm -rf "$CHECKOUT_DIR"
  git clone --depth 1 --branch "$REF" "$REPO_URL" "$CHECKOUT_DIR"
fi

cd "$CHECKOUT_DIR"
exec sh ./scripts/install.sh "$@"
