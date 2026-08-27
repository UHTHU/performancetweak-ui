#!/usr/bin/env bash
# Installs autotune-tuner as a GNOME Shell extension (top-bar indicator
# controlling the intel-undervolt-autotune systemd service).
set -euo pipefail

UUID="autotune-tuner@local"
SRC="$(cd "$(dirname "$0")" && pwd)/extension/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$DEST"
cp "$SRC"/* "$DEST"/

echo "Copied extension to $DEST"

# Enable it against the running shell if possible.
if command -v gnome-extensions >/dev/null 2>&1; then
  gnome-extensions enable "$UUID" 2>/dev/null \
    && echo "Enabled: $UUID" \
    || echo "Note: could not enable now (no running GNOME session?)."
  echo "  → Check with:  gnome-extensions list"
  echo "  → Enable with: gnome-extensions enable $UUID"
else
  echo "gnome-extensions not found — log in to GNOME and enable via:"
  echo "  gnome-extensions enable $UUID"
fi

echo
echo "Requires the intel-undervolt-autotune systemd service (see the"
echo "performancetweak repo): ./configure --enable-systemd && sudo make install"
echo "plus the polkit rule installed by make install (no password prompts)."