#!/usr/bin/env bash
# macOS/Linux equivalent of build_release.ps1
# Bumps manifest.json's version, builds the plugin, and packages it into a zip.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

read -rp "Enter version number (e.g. 1.0.1): " VERSION
if [[ -z "${VERSION// /}" ]]; then
  echo "Error: version number is required." >&2
  exit 1
fi

MANIFEST_PATH="manifest.json"
if [[ -f "$MANIFEST_PATH" ]]; then
  node -e "
    const fs = require('fs');
    const path = '$MANIFEST_PATH';
    const manifest = JSON.parse(fs.readFileSync(path, 'utf8'));
    manifest.version = '$VERSION';
    fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  "
  echo "Updated manifest.json to version $VERSION"
else
  echo "Warning: manifest.json not found, skipping version update." >&2
fi

echo "Building project..."
npm run build

RELEASE_DIR="obsidian-sysaudio-recorder"
ZIP_FILE="obsidian-sysaudio-recorder.zip"

# Clean up previous build artifacts
rm -rf "$RELEASE_DIR"
rm -f "$ZIP_FILE"

# Create release directory
mkdir -p "$RELEASE_DIR"

# Copy files
FILES_TO_COPY=("main.js" "styles.css" "control-window.html" "manifest.json")
for f in "${FILES_TO_COPY[@]}"; do
  if [[ -f "$f" ]]; then
    cp "$f" "$RELEASE_DIR/"
  else
    echo "Warning: file not found: $f" >&2
  fi
done

# Create zip archive
echo "Creating zip archive..."
zip -r -q "$ZIP_FILE" "$RELEASE_DIR"

# Clean up release directory
rm -rf "$RELEASE_DIR"

echo "Release build created: $ZIP_FILE"
