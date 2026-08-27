#!/usr/bin/env bash
# Removes autotune-tuner from the GNOME Shell.
set -euo pipefail

UUID="autotune-tuner@local"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

if command -v gnome-extensions >/dev/null 2>&1; then
  gnome-extensions disable "$UUID" 2>/dev/null || true
  gnome-extensions uninstall "$UUID" 2>/dev/null || true
fi
rm -rf "$DEST"
echo "Removed $UUID"