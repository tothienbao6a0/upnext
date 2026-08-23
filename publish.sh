#!/usr/bin/env bash
# Publish all three packages with one OTP. Reports honestly per package.
set -uo pipefail
OTP="$1"
cd "$(dirname "$0")"
FAILED=()
for p in core adapter-local adapter-process; do
  if npm publish -w "packages/$p" --otp="$OTP" >/tmp/pub-$p.log 2>&1; then
    echo "PUBLISHED  @upnext-core/$p"
  else
    echo "FAILED     @upnext-core/$p  -> $(grep -m1 'npm error' /tmp/pub-$p.log | head -c 100)"
    FAILED+=("$p")
  fi
done
echo "---"
for p in core adapter-local adapter-process; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "https://registry.npmjs.org/@upnext-core%2f$p")
  [ "$code" = "200" ] && echo "live: @upnext-core/$p" || echo "not live: @upnext-core/$p"
done
[ ${#FAILED[@]} -eq 0 ] || exit 1
