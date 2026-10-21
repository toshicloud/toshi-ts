#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# pin.env sets TOSHI_SERVER_REF, the Toshi server commit to test against; TOSHI_SERVER_REPOSITORY
# names the server repository.
# shellcheck source=/dev/null
source "$root/pin.env"

for tool in mise pnpm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "integration: $tool is not on PATH; run it under mise (mise exec -- scripts/integration.sh)" >&2
    exit 1
  fi
done

: "${TOSHI_SERVER_REPOSITORY:?set TOSHI_SERVER_REPOSITORY to the Toshi server repository}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git clone --quiet "$TOSHI_SERVER_REPOSITORY" "$tmp/server"
git -C "$tmp/server" checkout --quiet --detach "$TOSHI_SERVER_REF"

# The server pins its own Go in mise.toml; install and build with that version.
# The clone is the pinned commit this script builds and runs, so its config is trusted.
(
  cd "$tmp/server"
  export MISE_TRUSTED_CONFIG_PATHS="$tmp/server"
  mise install go
  mise exec go -- go build -o "$tmp/toshi" ./cmd/toshi
)

pnpm install --frozen-lockfile

echo "serving Toshi $TOSHI_SERVER_REF from $tmp/toshi"
TOSHI_INTEGRATION_BIN="$tmp/toshi" \
TOSHI_INTEGRATION_EXPECT_COMMIT="$TOSHI_SERVER_REF" \
  mise exec -- pnpm vitest run test/integration
