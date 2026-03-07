#!/bin/bash
# Post-install: auto-add shell integration

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

MARKER="# shellwise shell integration"

# Detect sw binary path
SW_BIN=""
if command -v sw &>/dev/null; then
  SW_BIN="sw"
else
  # Try common global bin paths
  for p in "$HOME/.bun/bin/sw" "$HOME/.local/bin/sw" "$(npm prefix -g 2>/dev/null)/bin/sw"; do
    if [[ -x "$p" ]]; then
      SW_BIN="$p"
      break
    fi
  done
fi

if [[ -z "$SW_BIN" ]]; then
  echo -e "${YELLOW}[shellwise]${RESET} Could not find sw binary. Add manually:"
  echo '  eval "$(sw init zsh)"   # add to ~/.zshrc'
  exit 0
fi

inject_to_rc() {
  local rc_file="$1"
  local shell_name="$2"

  # Skip if already injected
  if grep -qF "$MARKER" "$rc_file" 2>/dev/null; then
    echo -e "${DIM}[shellwise] Already configured in $rc_file${RESET}"
    return
  fi

  # Backup
  if [[ -f "$rc_file" ]]; then
    cp "$rc_file" "${rc_file}.shellwise-backup"
  fi

  # Append integration
  cat >> "$rc_file" << EOF

$MARKER
eval "\$($SW_BIN init $shell_name)"
EOF

  echo -e "${GREEN}${BOLD}[shellwise]${RESET}${GREEN} Added to $rc_file${RESET}"
}

# Detect user's shell and inject
SHELL_NAME=$(basename "${SHELL:-/bin/zsh}")

case "$SHELL_NAME" in
  zsh)
    inject_to_rc "$HOME/.zshrc" "zsh"
    ;;
  bash)
    # Prefer .bashrc, fallback to .bash_profile on macOS
    if [[ -f "$HOME/.bashrc" ]]; then
      inject_to_rc "$HOME/.bashrc" "bash"
    else
      inject_to_rc "$HOME/.bash_profile" "bash"
    fi
    ;;
  *)
    echo -e "${YELLOW}[shellwise]${RESET} Unsupported shell: $SHELL_NAME"
    echo '  Supported: zsh, bash'
    echo '  Add manually: eval "$(sw init zsh)"'
    exit 0
    ;;
esac

# Start daemon for fast suggest
if command -v sw &>/dev/null; then
  sw daemon start &>/dev/null || true
fi

echo -e "${GREEN}${BOLD}[shellwise]${RESET} Restart your terminal or run: ${BOLD}source ~/.${SHELL_NAME}rc${RESET}"
echo -e "${DIM}  Auto-save:    commands are recorded automatically"
echo -e "  Auto-suggest: inline dropdown as you type (Tab/S-Tab to navigate)"
echo -e "  Ctrl+R:       full interactive fuzzy search"
echo -e "  Daemon:       auto-started for ~1-3ms suggest speed${RESET}"
