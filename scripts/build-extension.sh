#!/usr/bin/env bash
# Assemble dist/chrome and dist/firefox from one source tree.
# No bundling: copy src + icons and pick the right manifest.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
for target in chrome firefox; do
  out="$root/dist/$target"
  rm -rf "$out"; mkdir -p "$out"
  cp -R "$root/Extension/src" "$out/src"
  cp -R "$root/Extension/icons" "$out/icons"
  cp "$root/Extension/manifest.$target.json" "$out/manifest.json"
done
echo "built dist/chrome and dist/firefox"
