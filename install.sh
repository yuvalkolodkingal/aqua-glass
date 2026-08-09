#!/usr/bin/env bash
# Aqua Glass - install.
#
# Copies the extension into place and compiles its settings schema. It does not
# touch any other extension's configuration; that only happens at runtime, with
# your consent, and is reverted by uninstall.sh.

set -euo pipefail

UUID="aqua-glass@yuvalkolodkingal.github.io"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/src"
DEST_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

[ -d "$SRC_DIR" ] || die "source directory not found: $SRC_DIR"
command -v glib-compile-schemas >/dev/null 2>&1 \
  || die "glib-compile-schemas not found (install libglib2.0-dev / glib2-devel)"

if command -v gnome-shell >/dev/null 2>&1; then
    version="$(gnome-shell --version | awk '{print $3}')"
    major="${version%%.*}"
    say "Detected GNOME Shell ${version}"
    if [ "$major" -lt 48 ] 2>/dev/null; then
        warn "Aqua Glass targets GNOME Shell 48 or newer; ${version} may not work."
    fi
fi

say "Compiling settings schema"
glib-compile-schemas "${SRC_DIR}/schemas"

say "Installing to ${DEST_DIR}"
rm -rf "$DEST_DIR"
mkdir -p "$DEST_DIR"
cp -r "${SRC_DIR}/." "${DEST_DIR}/"

say "Installed."
echo
if [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; then
    echo "  You are on Wayland, so the shell cannot be restarted in place."
    echo "  Log out and back in, then run:"
else
    echo "  Restart the shell with Alt+F2, r, Enter - then run:"
fi
echo
echo "      gnome-extensions enable ${UUID}"
echo
echo "  Preferences:  gnome-extensions prefs ${UUID}"
echo "  Self-check :  make selfcheck"
echo "  Remove     :  ./uninstall.sh"
