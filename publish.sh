#!/usr/bin/env bash
# Publish every package with one OTP. Reports honestly per package.
#
# `core` goes first because the adapters pin it by exact version, so a run that
# fails partway leaves adapters unpublished rather than adapters pointing at a
# version of the runtime that is not on the registry yet.
set -uo pipefail
OTP="$1"
cd "$(dirname "$0")"
PACKAGES=(core adapter-local adapter-process adapter-spotify adapter-browser adapter-nowplaying desktop)
FAILED=()

for p in "${PACKAGES[@]}"; do
  if npm publish -w "packages/$p" --otp="$OTP" >/tmp/pub-$p.log 2>&1; then
    echo "PUBLISHED  upnext-$p"
  else
    echo "FAILED     upnext-$p  -> $(grep -m1 'npm error' /tmp/pub-$p.log | head -c 100)"
    FAILED+=("$p")
  fi
done

echo "---"
for p in "${PACKAGES[@]}"; do
  # The packages are unscoped, so this is a plain name — the earlier `@upnext-core/…`
  # form was left over from before the rename and answered 404 for everything,
  # which made a completely successful publish print "not live" four times.
  code=$(curl -s -o /dev/null -w "%{http_code}" "https://registry.npmjs.org/upnext-$p")
  [ "$code" = "200" ] && echo "live: upnext-$p" || echo "not live: upnext-$p"
done

[ ${#FAILED[@]} -eq 0 ] || exit 1
