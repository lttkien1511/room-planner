#!/usr/bin/env bash
# Rebuild web/vendor/three.bundle.js (tree-shaken + minified three.js).
# Needs only Docker; nothing is installed on the host. No sudo required
# (the user must be in the docker group).
#
#   ./tools/build-vendor.sh
#
# Versions are pinned on purpose: bump them here, then commit the new bundle.
set -euo pipefail
cd "$(dirname "$0")/.."

THREE_VERSION=0.186.1
ESBUILD_VERSION=0.28.2
NODE_IMAGE=node:22-alpine

mkdir -p web/vendor .build-cache
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -e HOME=/work/.build-cache \
  -e npm_config_cache=/work/.build-cache/npm \
  -v "$PWD":/work -w /work \
  "$NODE_IMAGE" sh -c "
    set -e
    mkdir -p .build-cache/pkg && cd .build-cache/pkg
    [ -f package.json ] || npm init -y >/dev/null
    npm install --no-audit --no-fund --save-exact three@$THREE_VERSION esbuild@$ESBUILD_VERSION >/dev/null
    cp ../../tools/vendor-entry.js ./entry.js
    npx esbuild entry.js --bundle --minify --format=esm --target=es2020 \
      --legal-comments=none --outfile=../../web/vendor/three.bundle.js
  "
{
  echo "three.js $THREE_VERSION (MIT), bundled with esbuild $ESBUILD_VERSION"
  echo "entry: tools/vendor-entry.js"
} > web/vendor/VERSION.txt
ls -l web/vendor/three.bundle.js
gzip -c web/vendor/three.bundle.js | wc -c | awk '{printf "gzip size: %.0f KB\n", $1/1024}'
