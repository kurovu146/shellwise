#!/bin/bash
# Pre-uninstall: remove shell integration

MARKER="# shellwise shell integration"

remove_from_rc() {
  local rc_file="$1"

  [[ ! -f "$rc_file" ]] && return

  if grep -qF "$MARKER" "$rc_file" 2>/dev/null; then
    # Remove the marker line and the eval line after it
    sed -i.shellwise-uninstall '
      /^'"$MARKER"'$/,/^eval /d
    ' "$rc_file" 2>/dev/null || {
      # macOS sed requires different syntax
      sed -i '.shellwise-uninstall' '
        /^'"$MARKER"'$/,/^eval /d
      ' "$rc_file"
    }

    # Remove empty trailing lines left behind
    sed -i'' -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$rc_file" 2>/dev/null

    # Cleanup backup
    rm -f "${rc_file}.shellwise-uninstall"

    echo "[shellwise] Removed from $rc_file"
  fi
}

remove_from_rc "$HOME/.zshrc"
remove_from_rc "$HOME/.bashrc"
remove_from_rc "$HOME/.bash_profile"

echo "[shellwise] Uninstalled. Restart your terminal to complete."
