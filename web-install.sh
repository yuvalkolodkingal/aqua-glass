#!/usr/bin/env bash
# Aqua Glass - one-command network install.
#
#   curl -fsSL https://raw.githubusercontent.com/yuvalkolodkingal/aqua-glass/refs/heads/main/scripts/net-install.sh | bash
#
# Self-contained on purpose: it is meant to be piped straight into bash, so it
# never reads stdin (that is the script itself) and never assumes the
# repository is already on disk.
#
# Environment overrides:
#   AQUA_GLASS_REPO       owner/repo            (default yuvalkolodkingal/aqua-glass)
#   AQUA_GLASS_REF        branch, tag or commit (default main)
#   AQUA_GLASS_NO_ENABLE  set to 1 to install without enabling

set -euo pipefail

REPO="${AQUA_GLASS_REPO:-yuvalkolodkingal/aqua-glass}"
REF="${AQUA_GLASS_REF:-main}"
UUID="aqua-glass@yuvalkolodkingal.github.io"
DEST="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m xx\033[0m %s\n' "$*" >&2; exit 1; }

for tool in curl tar glib-compile-schemas; do
    command -v "$tool" >/dev/null 2>&1 || die "'$tool' is required but not installed."
done

if command -v gnome-shell >/dev/null 2>&1; then
    version="$(gnome-shell --version 2>/dev/null | awk '{print $3}')"
    major="${version%%.*}"
    say "GNOME Shell ${version} detected"
    if [ -n "${major:-}" ] && [ "$major" -lt 48 ] 2>/dev/null; then
        warn "Aqua Glass targets GNOME Shell 48 or newer; ${version} may not work."
    fi
else
    warn "gnome-shell not found on PATH - installing anyway."
fi

tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

# Branches live under refs/heads/; tags and raw commit SHAs do not. Try the
# branch form first, then fall back so a tag or commit works too.
say "Downloading ${REPO} @ ${REF}"
if ! curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/refs/heads/${REF}" \
        | tar -xz --strip-components=1 -C "$tmp" 2>/dev/null; then
    rm -rf "${tmp:?}/"* 2>/dev/null || true
    curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/${REF}" \
        | tar -xz --strip-components=1 -C "$tmp" \
        || die "could not download ${REPO} @ ${REF} - check the repo and ref names."
fi

[ -f "$tmp/src/metadata.json" ] \
    || die "downloaded archive does not look like Aqua Glass (no src/metadata.json)."

say "Compiling settings schema"
glib-compile-schemas "$tmp/src/schemas"

say "Installing to ${DEST}"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$tmp/src/." "$DEST/"

enabled=0
if [ "${AQUA_GLASS_NO_ENABLE:-0}" != "1" ] && command -v gnome-extensions >/dev/null 2>&1; then
    # This only succeeds if the running shell has already picked the extension
    # up; on a fresh install it usually has not, which is not an error.
    if gnome-extensions enable "$UUID" >/dev/null 2>&1; then
        enabled=1
    fi
fi

echo
say "Aqua Glass installed."
echo
if [ "$enabled" = "1" ]; then
    echo "    Enabled and running."
else
    if [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; then
        echo "    Wayland cannot restart the shell in place. Log out and back in, then:"
    else
        echo "    Restart the shell with Alt+F2, r, Enter - then:"
    fi
    echo
    echo "        gnome-extensions enable ${UUID}"
fi
echo
echo "    Preferences : gnome-extensions prefs ${UUID}"
echo "    Self-check  : gdbus call --session --dest org.gnome.Shell \\"
echo "                    --object-path /org/gnome/Shell/Extensions/AquaGlass \\"
echo "                    --method org.gnome.Shell.Extensions.AquaGlass.SelfCheck"
echo "    Remove      : curl -fsSL https://raw.githubusercontent.com/${REPO}/refs/heads/${REF}/uninstall.sh | bash"
echo
