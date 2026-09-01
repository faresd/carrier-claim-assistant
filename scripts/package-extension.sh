#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"
VERSION="$("$NODE_BIN" -p "require('$PROJECT_DIR/manifest.json').version")"
DIST_DIR="$PROJECT_DIR/dist"
STAGING_DIR="$PROJECT_DIR/.build/package-extension"
ARCHIVE_NAME="carrier-claim-assistant-v${VERSION}.zip"
ARCHIVE_PATH="$DIST_DIR/$ARCHIVE_NAME"

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR/src" "$STAGING_DIR/icons" "$DIST_DIR"

cp "$PROJECT_DIR/manifest.json" "$STAGING_DIR/manifest.json"
cp -R "$PROJECT_DIR/src/." "$STAGING_DIR/src/"
cp -R "$PROJECT_DIR/icons/." "$STAGING_DIR/icons/"

rm -f "$ARCHIVE_PATH"
(
  cd "$STAGING_DIR"
  zip -q -r "$ARCHIVE_PATH" manifest.json src icons
)

"$NODE_BIN" "$SCRIPT_DIR/inspect-package.mjs" "$ARCHIVE_PATH"
printf '%s\n' "$ARCHIVE_PATH"
