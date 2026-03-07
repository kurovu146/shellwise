#!/bin/bash
# Pre-uninstall: remove shell integration

MARKER="# shellwise shell integration"

remove_from_rc() {
  local rc_file="$1"

  [[ ! -f "$rc_file" ]] && return

  if grep -qF "$MARKER" "$rc_file" 2>/dev/null; then
    # Create backup
    cp "$rc_file" "${rc_file}.shellwise-backup"

    # Remove marker line and the eval line after it
    grep -vF "$MARKER" "$rc_file" | grep -v '^eval "\$(shellwise init' | grep -v '^eval "\$(sw init' > "${rc_file}.tmp"
    mv "${rc_file}.tmp" "$rc_file"

    # Cleanup backup
    rm -f "${rc_file}.shellwise-backup"

    echo "[shellwise] Removed from $rc_file"
  fi
}

remove_from_rc "$HOME/.zshrc"
remove_from_rc "$HOME/.bashrc"
remove_from_rc "$HOME/.bash_profile"

# Stop daemon
pid=$(head -1 "/tmp/shellwise-$(id -u).pid" 2>/dev/null) && kill "$pid" 2>/dev/null
rm -f "/tmp/shellwise-$(id -u).pid" "/tmp/shellwise-$(id -u).sock"

echo "[shellwise] Uninstalled. Restart your terminal to complete."
