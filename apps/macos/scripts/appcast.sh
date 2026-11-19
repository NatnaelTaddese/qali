#!/bin/sh
# Writes the Sparkle appcast for one release zip to stdout: a single item
# carrying the zip's version, build and EdDSA signature. The release workflow
# uploads it beside the zip, and the app reads it through
# releases/latest/download/appcast.xml (Qali/App/AppUpdater.swift).
#   SIGN_UPDATE=<Sparkle>/bin/sign_update scripts/appcast.sh <zip> <download-url> [<notes-url>]
# The key is SPARKLE_PRIVATE_KEY when set (CI), otherwise the `qali` account
# in the login keychain, where generate_keys put it.
set -eu

ZIP=$1
URL=$2
NOTES=${3:-}
: "${SIGN_UPDATE:?Set SIGN_UPDATE to the sign_update tool from the Sparkle release}"

PLIST=$(mktemp)
unzip -p "$ZIP" Qali.app/Contents/Info.plist > "$PLIST"
VERSION=$(plutil -extract CFBundleShortVersionString raw "$PLIST")
BUILD=$(plutil -extract CFBundleVersion raw "$PLIST")
MIN_OS=$(plutil -extract LSMinimumSystemVersion raw "$PLIST")
rm "$PLIST"

if [ -n "${SPARKLE_PRIVATE_KEY:-}" ]; then
  SIGNATURE=$(printf '%s' "$SPARKLE_PRIVATE_KEY" | "$SIGN_UPDATE" --ed-key-file - -p "$ZIP")
else
  SIGNATURE=$("$SIGN_UPDATE" --account qali -p "$ZIP")
fi
LENGTH=$(stat -f %z "$ZIP")
DATE=$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')
NOTES_LINE=""
if [ -n "$NOTES" ]; then
  NOTES_LINE="
      <sparkle:fullReleaseNotesLink>$NOTES</sparkle:fullReleaseNotesLink>"
fi

cat <<XML
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Qali for Mac</title>
    <item>
      <title>Qali $VERSION</title>
      <pubDate>$DATE</pubDate>
      <sparkle:version>$BUILD</sparkle:version>
      <sparkle:shortVersionString>$VERSION</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>$MIN_OS</sparkle:minimumSystemVersion>$NOTES_LINE
      <enclosure url="$URL" length="$LENGTH" type="application/octet-stream" sparkle:edSignature="$SIGNATURE"/>
    </item>
  </channel>
</rss>
XML
