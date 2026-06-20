#!/usr/bin/env bash
# Build cross-platform standalone binaries and tarballs into release/.
# Usage: bash scripts/build-release.sh
set -euo pipefail

cd "$(dirname "$0")/.."

TARGETS=(darwin-arm64 darwin-x64 linux-arm64 linux-x64)

mkdir -p release
for t in "${TARGETS[@]}"; do
  echo "→ building shellwise-$t"
  bun build src/index.ts --compile --target="bun-$t" --outfile "release/shellwise-$t"
  tar -czf "release/shellwise-$t.tar.gz" -C release "shellwise-$t"
done

echo
echo "Checksums:"
( cd release && shasum -a 256 shellwise-*.tar.gz )
