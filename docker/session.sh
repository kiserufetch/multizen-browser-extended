#!/bin/sh
# What a desktop session has and a container doesn't, started before the command it runs.
#
# A sound server: with none, Chromium falls back to its fake audio output (AudioContext.baseLatency
# 441/48000) and Firefox has no device at all (44100 Hz, 0 channels, no media devices). PipeWire,
# as current desktops run it, with the silent speakers and microphone of docker/pipewire.conf.
# Browsers reach it through XDG_RUNTIME_DIR, which both drivers pass on to them.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-$(id -u)}"
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"

# WirePlumber, which links each stream to a device, needs a session bus. This one is its own,
# outside XDG_RUNTIME_DIR: a browser looks for $XDG_RUNTIME_DIR/bus, and gets none.
bus="unix:path=/tmp/multizen-audio-bus-$(id -u)"
if dbus-daemon --session --fork --address="$bus" >/dev/null 2>&1; then
  pipewire >/dev/null 2>&1 &
  DBUS_SESSION_BUS_ADDRESS="$bus" wireplumber >/dev/null 2>&1 &
  pipewire-pulse >/dev/null 2>&1 &
  # The first page shouldn't race the server: give it a few seconds to put up its socket.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -S "$XDG_RUNTIME_DIR/pulse/native" ] && break
    sleep 0.3
  done
fi
[ -S "$XDG_RUNTIME_DIR/pulse/native" ] || echo "session: no sound server, pages will see no audio device" >&2

# No speech-dispatcher: with espeak-ng, Camoufox lists its 13,362 voices to every page, and
# CloakBrowser keeps its own list either way (docs/detection-baselines).
exec "$@"
