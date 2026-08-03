export function generateBashScript(bin: string): string {
  return `
# --- shellwise shell integration ---

export SW_SESSION_ID="\$(command uuidgen 2>/dev/null || echo "\$\$-\$RANDOM")"

# An older release exported these, so a parent shell may still be leaking them
# into this one. Drop them before the first prompt, or this shell would record
# whatever the parent was running.
unset __SW_COMMAND __SW_START_TIME

# ─── Command Capture ───────────────────────────────────────

__sw_preexec() {
  # Shell-local, never exported: an exported value is inherited by every child
  # shell, which would then save the parent's command again on its first
  # prompt — with the child's cwd and session id.
  __SW_START_TIME=\$SECONDS
  __SW_COMMAND="\$(HISTTIMEFORMAT= history 1 | sed 's/^[ ]*[0-9]*[ ]*//')"
}

__sw_precmd() {
  local exit_code=\$?
  if [[ -n "\$__SW_COMMAND" ]]; then
    local duration=\$(( (SECONDS - __SW_START_TIME) * 1000 ))

    command ${bin} add \\
      --command "\$__SW_COMMAND" \\
      --cwd "\$PWD" \\
      --exit-code "\$exit_code" \\
      --duration "\$duration" \\
      --session "\$SW_SESSION_ID" \\
      --shell "bash" &

    unset __SW_COMMAND __SW_START_TIME
  fi
}

PROMPT_COMMAND="__sw_precmd;\${PROMPT_COMMAND}"
trap '__sw_preexec' DEBUG

# ─── Ctrl+R: interactive search ────────────────────────────

__sw_search() {
  local selected
  selected="\$(command ${bin} search --query "\$READLINE_LINE" </dev/tty 2>/dev/tty)"
  if [[ -n "\$selected" ]]; then
    READLINE_LINE="\$selected"
    READLINE_POINT=\${#READLINE_LINE}
  fi
}

bind -x '"\\C-r": __sw_search'
`;
}
