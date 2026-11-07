#!/usr/bin/env bash
# Build Qali (release) and install it as ~/Applications/Qali Dev.app with the qali:// scheme
# registered, so Google sign-in can hand the session back. A bare `cargo run` binary has no
# bundle and never receives links.
#
# Uses Rune's own installer (scripts/mac-app) from a checkout at the same rev Cargo.toml pins,
# kept in apps/desktop/.rune (gitignored). Extra arguments go to the app.
set -euo pipefail
cd "$(dirname "$0")/.."

rev=$(sed -n 's/^rune = .*rev = "\([0-9a-f]*\)".*/\1/p' Cargo.toml)
if [ -z "$rev" ]; then echo "couldn't read Rune's rev from Cargo.toml" >&2; exit 1; fi
if [ "$(git -C .rune rev-parse HEAD 2>/dev/null)" != "$rev" ]; then
  rm -rf .rune
  git init -q .rune
  git -C .rune fetch -q --depth 1 https://github.com/anomalyco/rune "$rev"
  git -C .rune checkout -q FETCH_HEAD
fi

# Sign with a stable identity so the Keychain keeps trusting rebuilds. An ad-hoc signature
# makes every build a new app to macOS, which then prompts for (and can stall on) the saved
# session. Override with MAC_APP_SIGN, or set it empty to sign ad hoc.
if [ -z "${MAC_APP_SIGN+set}" ]; then
  MAC_APP_SIGN=$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development: [^"]*\)".*/\1/p' | head -1)
fi
export MAC_APP_SIGN

cargo build --release
exec .rune/scripts/mac-app \
  --name "Qali Dev" \
  --id com.myqali.desktop.dev \
  --exe qali-desktop \
  --bin target/release/qali-desktop \
  --scheme qali \
  -- "$@"
