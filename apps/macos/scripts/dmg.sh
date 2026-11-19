#!/bin/sh
# Wraps Qali.app in a drag-to-install DMG: the app beside an Applications
# link, on the Packaging/dmg-background.tiff window. scripts/release.sh calls
# this when dmgbuild is available (Python 3.11 or later):
#   python3 -m venv .venv && .venv/bin/pip install dmgbuild==2.0.0
#   DMGBUILD=.venv/bin/dmgbuild scripts/dmg.sh <Qali.app> <out.dmg>
set -eu
APP="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
mkdir -p "$(dirname "$2")"
OUT="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
cd "$(dirname "$0")/.."

rm -f "$OUT"
"${DMGBUILD:-dmgbuild}" -s scripts/dmg-settings.py \
  -D app="$APP" -D background="$PWD/Packaging/dmg-background.tiff" \
  "Qali" "$OUT"
hdiutil verify -quiet "$OUT"

# The app inside must still pass a strict signature check, or Gatekeeper may
# call it damaged.
MOUNT=$(mktemp -d)
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$MOUNT" "$OUT"
STATUS=0
codesign --verify --strict --deep "$MOUNT/$(basename "$APP")" || STATUS=$?
hdiutil detach -quiet "$MOUNT"
rmdir "$MOUNT"
exit $STATUS
