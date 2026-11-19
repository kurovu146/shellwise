#!/usr/bin/env bash
# Build cross-platform standalone binaries, tarballs and a Windows zip into release/.
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

echo "→ building shellwise-windows-x64"
bun build src/index.ts --compile --target=bun-windows-x64 --outfile release/shellwise-windows-x64/shellwise.exe
( cd release/shellwise-windows-x64 && zip -q ../shellwise-windows-x64.zip shellwise.exe )

echo
echo "Checksums:"
( cd release && shasum -a 256 shellwise-*.tar.gz shellwise-*.zip )
