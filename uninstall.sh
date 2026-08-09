#!/usr/bin/env bash
# Aqua Glass - the one-command revert.
#
# Puts everything back:
#   1. disables the extension, which makes it restore every surface's real
#      background and undo the changes it made to Blur My Shell and Dash to
#      Dock (that restore lives in the extension's disable()),
#   2. restores those same keys directly as a fallback, in case the extension
#      was not running to do it itself,
#   3. resets Aqua Glass's own settings,
#   4. deletes the installed files.

set -uo pipefail

UUID="aqua-glass@yuvalkolodkingal.github.io"
DEST_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"
SCHEMA="org.gnome.shell.extensions.aqua-glass"
CACHE_DIR="${HOME}/.cache/aqua-glass"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }

# --- 1. disable, letting the extension revert its own changes ---------------
if command -v gnome-extensions >/dev/null 2>&1; then
    if gnome-extensions list --enabled 2>/dev/null | grep -qx "$UUID"; then
        say "Disabling ${UUID} (this triggers its own revert)"
        gnome-extensions disable "$UUID" 2>/dev/null || true
        sleep 1
    fi
fi

# --- 2. fallback restore, straight from the backups we stored --------------
restore_backups() {
    command -v gsettings >/dev/null 2>&1 || return 0
    gsettings list-schemas 2>/dev/null | grep -qx "$SCHEMA" || return 0

    local bms dtd
    bms="$(gsettings get "$SCHEMA" blur-my-shell-backup 2>/dev/null || echo "''")"
    dtd="$(gsettings get "$SCHEMA" dash-to-dock-backup 2>/dev/null || echo "''")"

    if ! command -v python3 >/dev/null 2>&1; then
        [ "$bms" = "''" ] && [ "$dtd" = "''" ] && return 0
        warn "python3 not available; cannot replay saved backups automatically."
        warn "Blur My Shell backup: ${bms}"
        warn "Dash to Dock backup : ${dtd}"
        return 0
    fi

    python3 - "$bms" "$dtd" <<'PY'
import ast, json, subprocess, sys

def unquote(raw):
    raw = raw.strip()
    if not raw or raw == "''":
        return {}
    try:
        text = ast.literal_eval(raw)
    except (ValueError, SyntaxError):
        return {}
    if not text:
        return {}
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}

def gset(schema, path, key, value):
    args = ["gsettings"]
    if path:
        args += ["set", f"{schema}:{path}", key, value]
    else:
        args += ["set", schema, key, value]
    subprocess.run(args, check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

bms = unquote(sys.argv[1])
for component, enabled in bms.items():
    schema = "org.gnome.shell.extensions.blur-my-shell." + component
    path = f"/org/gnome/shell/extensions/blur-my-shell/{component}/"
    gset(schema, path, "blur", "true" if enabled else "false")
    print(f"    restored blur-my-shell/{component}/blur = {bool(enabled)}")

dtd = unquote(sys.argv[2])
for key, value in dtd.items():
    if isinstance(value, bool):
        text = "true" if value else "false"
    elif isinstance(value, (int, float)):
        text = repr(float(value))
    else:
        text = f"'{value}'"
    gset("org.gnome.shell.extensions.dash-to-dock", None, key, text)
    print(f"    restored dash-to-dock/{key} = {value}")
PY
}

say "Restoring other extensions' settings"
restore_backups

# --- 3. reset our own settings ---------------------------------------------
if command -v dconf >/dev/null 2>&1; then
    say "Resetting Aqua Glass settings"
    dconf reset -f /org/gnome/shell/extensions/aqua-glass/ 2>/dev/null || true
fi

# --- 4. remove the files ----------------------------------------------------
if [ -d "$DEST_DIR" ]; then
    say "Removing ${DEST_DIR}"
    rm -rf "$DEST_DIR"
fi
[ -d "$CACHE_DIR" ] && rm -rf "$CACHE_DIR"

say "Aqua Glass removed."
if [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; then
    echo "    Log out and back in to clear it from the running shell."
else
    echo "    Restart the shell with Alt+F2, r, Enter."
fi
