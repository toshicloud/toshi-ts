#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# shellcheck source=/dev/null
source "$root/pin.env"

for tool in buf protoc-gen-es; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "generate: $tool is not on PATH; run it under mise (mise exec -- scripts/generate.sh)" >&2
    exit 1
  fi
done

buf generate "$TOSHI_API_REPOSITORY#commit=$TOSHI_API_REF" --path proto/toshi/workspace/v1
