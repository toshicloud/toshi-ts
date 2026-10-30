#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# shellcheck source=/dev/null
source "$root/pin.env"

if ! command -v buf >/dev/null 2>&1; then
  echo "generate: buf is not on PATH; run it under mise (mise exec -- scripts/generate.sh)" >&2
  exit 1
fi

plugin="$root/node_modules/.bin/protoc-gen-es"
if [ ! -x "$plugin" ]; then
  echo "generate: $plugin is missing; run pnpm install --frozen-lockfile" >&2
  exit 1
fi

# The generator and the runtime it generates for are the same exact
# devDependency version in package.json, and both must be installed at it.
node --input-type=module - "$root" <<'NODE'
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
const names = ["@bufbuild/protoc-gen-es", "@bufbuild/protobuf"];

try {
  const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
  const dev = read("package.json").devDependencies ?? {};
  const pin = dev[names[0]];
  if (typeof pin !== "string" || !pin || names.some((name) => dev[name] !== pin)) {
    throw new Error("package.json must pin the generator and the runtime to the same exact version");
  }
  for (const name of names) {
    if (read(`node_modules/${name}/package.json`).version !== pin) {
      throw new Error(`${name} is not installed at the pinned version ${pin}`);
    }
  }
} catch (error) {
  console.error(`generate: ${error.message}; run pnpm install --frozen-lockfile`);
  process.exit(1);
}
NODE

buf generate "$TOSHI_API_REPOSITORY#commit=$TOSHI_API_REF" --path proto/toshi/workspace/v1 --path proto/toshi/permission.proto
