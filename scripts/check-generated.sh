#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

scripts/generate.sh

message="src/gen/ or src/version.ts differs from what pin.env generates; run scripts/generate.sh and commit the result"

if ! git diff --exit-code -- src/gen src/version.ts; then
  echo "$message" >&2
  exit 1
fi

if [ -n "$(git status --porcelain -- src/gen src/version.ts)" ]; then
  echo "$message" >&2
  exit 1
fi
