#!/usr/bin/env bash
#
# Publish every package. Safe to re-run.
#
#   ./publish.sh            # npm asks for auth as it goes (browser or prompt)
#   ./publish.sh 123456     # pass a one-time code once, for all of them
#
# Three properties that matter, learned from a run that silently did nothing:
#
#   * It does not stop at the first failure and it does not chain with `&&`,
#     so one package failing is reported rather than hiding the eight behind it.
#   * It skips anything already on the registry at this version, so a run that
#     died halfway can simply be run again — only the remainder is published.
#   * It checks the build, the tests and the version consistency *first*.
#     Publishing is irreversible after 72 hours; a broken tarball is forever.
set -uo pipefail
cd "$(dirname "$0")"

OTP="${1:-}"

# Validated rather than trusted, because an interactive zsh does not treat `#`
# as a comment — so pasting a command with a trailing note attached sends the
# `#` here as the one-time code, and npm rejects all nine publishes with a
# message about a regex. Anything that is not digits is refused up front.
if [ -n "$OTP" ] && ! printf '%s' "$OTP" | grep -Eq '^[0-9]{6,8}$'; then
  printf 'Not a one-time code: %s\n' "$OTP"
  printf 'Pass six digits from your authenticator, or nothing at all:\n'
  printf '  ./publish.sh\n'
  printf '  ./publish.sh 123456\n'
  exit 1
fi

# Written out rather than expanding a possibly-empty array: bash 3.2, which is
# what macOS ships, treats "${arr[@]}" on an empty array as an unbound variable
# under `set -u`.
publish_one() {
  if [ -n "$OTP" ]; then
    npm publish -w "packages/$1" --otp="$OTP"
  else
    npm publish -w "packages/$1"
  fi
}

# core first: the adapters pin it by exact version, so if a run does die partway
# it leaves adapters unpublished rather than adapters pointing at a runtime that
# is not on the registry yet.
PACKAGES=(core adapter-local adapter-process adapter-spotify adapter-browser adapter-nowplaying adapter-apple-music desktop mcp)

say() { printf '%s\n' "$*"; }

# -- preflight ---------------------------------------------------------------

say "checking versions agree…"
VERSIONS=$(for p in "${PACKAGES[@]}"; do node -p "require('./packages/$p/package.json').version"; done | sort -u)
if [ "$(echo "$VERSIONS" | wc -l | tr -d ' ')" != "1" ]; then
  say "ABORT: packages are at different versions:"; echo "$VERSIONS"; exit 1
fi
VERSION=$(echo "$VERSIONS" | head -1)
say "  all at $VERSION"

say "building and testing…"
if ! npm run build >/tmp/publish-build.log 2>&1; then
  say "ABORT: build failed — see /tmp/publish-build.log"; exit 1
fi
if ! npm test >/tmp/publish-test.log 2>&1; then
  say "ABORT: tests failed — see /tmp/publish-test.log"; exit 1
fi
say "  green"
say ""

# -- publish -----------------------------------------------------------------

PUBLISHED=(); SKIPPED=(); FAILED=()

for p in "${PACKAGES[@]}"; do
  name=$(node -p "require('./packages/$p/package.json').name")

  # Already there? Then a previous run got this far. Nothing to do.
  if npm view "$name@$VERSION" version >/dev/null 2>&1; then
    say "already live   $name@$VERSION"
    SKIPPED+=("$name"); continue
  fi

  if publish_one "$p" >"/tmp/publish-$p.log" 2>&1; then
    say "PUBLISHED      $name@$VERSION"
    PUBLISHED+=("$name")
  else
    say "FAILED         $name -> $(grep -m1 'npm error' "/tmp/publish-$p.log" | head -c 120)"
    FAILED+=("$name")
  fi
done

# -- verify against the registry, not against our own optimism ---------------

say ""
say "checking the registry…"
for p in "${PACKAGES[@]}"; do
  name=$(node -p "require('./packages/$p/package.json').name")
  live=$(npm view "$name" version 2>/dev/null || echo "—")
  [ "$live" = "$VERSION" ] && say "  live      $name@$live" || say "  NOT LIVE  $name (registry says $live)"
done

say ""
say "published ${#PUBLISHED[@]}, already there ${#SKIPPED[@]}, failed ${#FAILED[@]}"
if [ ${#FAILED[@]} -ne 0 ]; then
  say "re-run this script to retry only what failed."
  exit 1
fi
