#!/usr/bin/env bash
# Installs the Autotune Tuner app:
#   ~/.local/bin/autotune-tuner        launcher
#   ~/.local/share/applications/autotune-tuner.desktop
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
BIN="$HOME/.local/bin"
APPS="$HOME/.local/share/applications"

mkdir -p "$BIN" "$APPS"

install -m 755 "$SRC/autotune-tuner.py" "$BIN/autotune-tuner"
sed "s,__BIN__,$BIN,g" "$SRC/autotune-tuner.desktop" \
    > "$APPS/autotune-tuner.desktop"

echo "Installed. Launch with:  autotune-tuner   (or find it in the app grid)"
echo "Prerequisite: the intel-undervolt-autotune systemd service + sudoers"
echo "scoping from the performancetweak repo (sudo make install)."