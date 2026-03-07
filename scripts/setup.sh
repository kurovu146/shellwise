#!/bin/bash
# Post-install: auto-add shell integration

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

# Detect if this is a local (not global) install
# npm adds node_modules/.bin to PATH during postinstall, so check the resolved path
SHELLWISE_PATH="$(command -v shellwise 2>/dev/null || true)"
if [[ -z "$SHELLWISE_PATH" ]] || [[ "$SHELLWISE_PATH" == *"/node_modules/.bin/"* ]]; then
  echo -e "${YELLOW}${BOLD}[shellwise]${RESET} This is a CLI tool — install it globally:" >&2
  echo -e "  ${BOLD}bun install -g shellwise${RESET}" >&2
  echo -e "  ${DIM}or: npm install -g shellwise${RESET}" >&2
  exit 0
fi

MARKER="# shellwise shell integration"

# Detect shellwise binary path (prefer 'shellwise' over 'sw' to avoid conflicts)
SW_BIN=""
if command -v shellwise &>/dev/null; then
  SW_BIN="shellwise"
elif command -v sw &>/dev/null; then
  # Verify it's actually shellwise, not another tool
  if sw --help 2>&1 | grep -q "shellwise" 2>/dev/null; then
    SW_BIN="sw"
  fi
fi

# Try common global bin paths
if [[ -z "$SW_BIN" ]]; then
  for p in "$HOME/.bun/bin/shellwise" "$HOME/.local/bin/shellwise" "$(npm prefix -g 2>/dev/null)/bin/shellwise"; do
    if [[ -x "$p" ]]; then
      SW_BIN="$p"
      break
    fi
  done
fi

if [[ -z "$SW_BIN" ]]; then
  echo -e "${YELLOW}[shellwise]${RESET} Could not find shellwise binary. Add manually:"
  echo '  eval "$(shellwise init zsh)"   # add to ~/.zshrc'
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
    echo '  Add manually: eval "$(shellwise init zsh)"'
    exit 0
    ;;
esac

# Start daemon for fast suggest
if command -v shellwise &>/dev/null; then
  shellwise daemon start &>/dev/null || true
elif [[ -n "$SW_BIN" ]]; then
  $SW_BIN daemon start &>/dev/null || true
fi

echo -e "${GREEN}${BOLD}[shellwise]${RESET} Restart your terminal or run: ${BOLD}source ~/.${SHELL_NAME}rc${RESET}"
echo -e "${DIM}  Auto-save:    commands are recorded automatically"
echo -e "  Auto-suggest: inline dropdown as you type (Tab/S-Tab to navigate)"
echo -e "  Ctrl+R:       full interactive fuzzy search"
echo -e "  Daemon:       auto-started for ~1-3ms suggest speed${RESET}"
