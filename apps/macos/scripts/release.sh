#!/bin/sh
# Builds the shareable Release app (prod backend, arm64) and zips it into
# dist/. CI runs this too (.github/workflows/macos-release.yml).
#   scripts/release.sh [build-number]
# Signs with Config/Local.xcconfig's identity if there is one, ad-hoc if not.
set -eu
cd "$(dirname "$0")/.."

BUILD="${1:-1}"
VERSION=$(sed -n 's/^ *MARKETING_VERSION: *//p' project.yml | head -n 1)
APP=build-release/Build/Products/Release/Qali.app
ZIP="dist/Qali-$VERSION-$BUILD-arm64.zip"

xcodegen generate --quiet
rm -rf "$APP"
xcodebuild -project Qali.xcodeproj -scheme Qali -configuration Release \
  -derivedDataPath build-release -destination 'generic/platform=macOS' \
  CURRENT_PROJECT_VERSION="$BUILD" -quiet build
codesign --verify --strict --deep "$APP"

mkdir -p dist
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "version=$VERSION"
    echo "build=$BUILD"
    echo "zip=apps/macos/$ZIP"
    echo "name=$(basename "$ZIP" .zip)"
  } >> "$GITHUB_OUTPUT"
fi
echo "$ZIP"
