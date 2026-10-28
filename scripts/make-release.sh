#!/usr/bin/env bash
# Builds release/fsmanager.tar.gz: the folder you copy to a manager server that can't use Git.
#   bash scripts/make-release.sh
# On the server:  tar xzf fsmanager.tar.gz && cd fsmanager && sudo bash install.sh
# The archive holds source only; install.sh installs dependencies and builds the app on the server.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OUT=$ROOT/release
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/fsmanager" "$OUT"
cd "$ROOT"
cp install.sh README.md LICENSE CHANGELOG.md "$STAGE/fsmanager/"
cp -r agent tools docs "$STAGE/fsmanager/"
mkdir -p "$STAGE/fsmanager/app"
cp -r app/src app/public app/package.json app/package-lock.json app/tsconfig.json "$STAGE/fsmanager/app/"

# Normalise line endings in case the checkout came from Windows with CRLF
find "$STAGE/fsmanager" -type f \( -name '*.sh' -o -path '*/agent/fs-agent*' \) -exec sed -i 's/\r$//' {} +
chmod 755 "$STAGE/fsmanager/install.sh" "$STAGE/fsmanager/agent/"* "$STAGE/fsmanager/tools/cert-tool.sh"

tar -C "$STAGE" -czf "$OUT/fsmanager.tar.gz" --owner=0 --group=0 fsmanager
echo "Built $OUT/fsmanager.tar.gz ($(du -h "$OUT/fsmanager.tar.gz" | cut -f1))"
