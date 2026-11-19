#!/bin/sh
# Builds the Debug app and opens it. Arguments are passed to the app, e.g.
#   scripts/run.sh -QaliScene signedOut
set -e
cd "$(dirname "$0")/.."
xcodegen generate --quiet
xcodebuild -project Qali.xcodeproj -scheme Qali -configuration Debug -derivedDataPath build -quiet build
pkill -x Qali 2>/dev/null || true
open build/Build/Products/Debug/Qali.app --args "$@"
