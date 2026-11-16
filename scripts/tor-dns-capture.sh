#!/usr/bin/env bash
# Capture real plaintext DNS during Minternet's native embedded Arti check.
# This is not a full system leak or fingerprinting audit.
set -euo pipefail
if [ "$#" -ne 1 ] || [ ! -x "$1" ]; then
  echo "Usage: tor-dns-capture.sh /absolute/path/to/minternet_native" >&2
  exit 2
fi
runner="$RUNNER_TEMP"
pcap="$runner/minternet-tor-dns.pcap"
decoded="$runner/minternet-tor-dns-decoded.txt"
log="$runner/minternet-tor-exit-proof.txt"
sudo timeout --signal=INT --kill-after=5s 720 tcpdump -U -i any -nn -s 0 -w "$pcap" 'udp port 53 or tcp port 53' \
  > /dev/null 2> "$runner/minternet-tor-tcpdump.err" &
capture_pid=$!
cleanup() {
  # CI runner is isolated: scope the packet capture by exact process name.
  # Kill the tcpdump child rather than only its sudo wrapper, which would
  # otherwise leave a blocking wait after a failed network probe.
  sudo pkill -INT -x tcpdump >/dev/null 2>&1 || true
  sudo kill -TERM "$capture_pid" >/dev/null 2>&1 || true
  sleep 1
  sudo pkill -KILL -x tcpdump >/dev/null 2>&1 || true
  sudo kill -KILL "$capture_pid" >/dev/null 2>&1 || true
  wait "$capture_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT
sleep 3
if ! kill -0 "$capture_pid" 2>/dev/null; then
  echo "FAIL: tcpdump exited before Tor verification" >&2
  cat "$runner/minternet-tor-tcpdump.err" >&2
  exit 1
fi
if ! timeout 650 "$1" --minternet-tor-transport-smoke > "$log" 2>&1; then
  echo "FAIL: Native Tor transport runtime verification did not pass" >&2
  tail -n 20 "$log" >&2
  exit 1
fi
if ! grep -Fq 'PASS: Embedded Arti verified by Tor Project' "$log"; then
  echo "FAIL: No genuine exit verification marker" >&2
  exit 1
fi
cleanup
trap - EXIT
sudo tcpdump -nn -vvv -r "$pcap" > "$decoded" 2> "$runner/minternet-tor-capture-read.err"
if grep -Eiq 'check\.torproject\.org|duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad\.onion' "$decoded"; then
  echo "FAIL: Tor destination hostname was exposed in plaintext DNS" >&2
  exit 1
fi
echo "PASS: Tor exit and v3 onion verified; no destination hostnames on TCP/UDP port-53 DNS packet capture."
echo "LIMIT: Transport-only DNS capture; not proof against DoH, all browser leaks, or fingerprinting."
