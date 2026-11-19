#!/bin/sh
# Builds the shareable Release app (prod backend, arm64) into dist/: a zip
# (what Sparkle updates from) and a drag-to-install DMG (what people download).
# CI runs this too (.github/workflows/macos-release.yml).
#   scripts/release.sh [build-number]
# Signs with Config/Local.xcconfig's identity if there is one, ad-hoc if not.
# The DMG needs dmgbuild (see scripts/dmg.sh): skipped when it isn't on the
# PATH, required when DMGBUILD names it.
set -eu
cd "$(dirname "$0")/.."

BUILD="${1:-1}"
VERSION=$(sed -n 's/^ *MARKETING_VERSION: *//p' project.yml | head -n 1)
APP=build-release/Build/Products/Release/Qali.app
ZIP="dist/Qali-$VERSION-arm64.zip"
DMG="dist/Qali-$VERSION-arm64.dmg"

xcodegen generate --quiet
rm -rf "$APP"
xcodebuild -project Qali.xcodeproj -scheme Qali -configuration Release \
  -derivedDataPath build-release -destination 'generic/platform=macOS' \
  CURRENT_PROJECT_VERSION="$BUILD" -quiet build
codesign --verify --strict --deep "$APP"

mkdir -p dist
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

rm -f "$DMG"
if [ -n "${DMGBUILD:-}" ] || command -v dmgbuild >/dev/null 2>&1; then
  scripts/dmg.sh "$APP" "$DMG"
else
  echo "dmgbuild isn't installed: skipping the DMG (see scripts/dmg.sh)" >&2
  DMG=""
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "version=$VERSION"
    echo "build=$BUILD"
    echo "zip=apps/macos/$ZIP"
    echo "dmg=${DMG:+apps/macos/$DMG}"
    echo "name=$(basename "$ZIP" .zip)"
  } >> "$GITHUB_OUTPUT"
fi
echo "$ZIP"
[ -z "$DMG" ] || echo "$DMG"
