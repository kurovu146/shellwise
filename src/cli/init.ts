export function runInit(shell: string, binaryPath: string): void {
  switch (shell) {
    case "zsh":
      process.stdout.write(generateZshScript(binaryPath));
      break;
    case "bash":
      process.stdout.write(generateBashScript(binaryPath));
      break;
    default:
      console.error(`Unsupported shell: ${shell}. Supported: zsh, bash`);
      process.exit(1);
  }
}

function generateZshScript(bin: string): string {
  return `
# --- shellwise shell integration ---

# Session tracking
export SW_SESSION_ID="\$(command uuidgen 2>/dev/null || echo "\$\$-\$RANDOM")"

# State
typeset -g __sw_prev_buffer=""
typeset -ga __sw_suggestions=()
typeset -g __sw_selected=0
typeset -g __sw_fd=""
typeset -g __sw_ready=0
# ─── Daemon connection (self-healing, Unix socket) ─────────
# Unix-domain socket: protected by filesystem permissions (0600), unlike a
# guessable localhost TCP port with no auth. The daemon idle-exits after
# inactivity, so the shell must reconnect on demand — otherwise a long-idle
# pane loses suggest forever.

typeset -g __sw_sock="/tmp/shellwise-\${UID}.sock"

# Is the daemon process alive? No fork (kill -0 + \$(<file) are builtins).
__sw_daemon_alive() {
  local pf="/tmp/shellwise-\${UID}.pid"
  [[ -f "\$pf" ]] || return 1
  local lines=("\${(@f)\$(<\$pf)}")
  kill -0 \${lines[1]:-0} 2>/dev/null
}

# (Re)establish the persistent connection. No fork while typing.
__sw_connect() {
  __sw_ready=0
  [[ -n "\$__sw_fd" ]] && { zsocket -c \$__sw_fd 2>/dev/null; __sw_fd="" }
  [[ -S "\$__sw_sock" ]] || return 1
  zsocket "\$__sw_sock" 2>/dev/null || return 1
  __sw_fd=\$REPLY
  __sw_ready=1
}

# Load socket module + connect at shell startup
zmodload zsh/net/socket 2>/dev/null && {
  if [[ ! -S "\$__sw_sock" ]]; then
    # Start daemon in background (non-blocking)
    command ${bin} daemon start &>/dev/null &!
    sleep 0.3
  fi
  __sw_connect
}

# ─── Persistent query (no connect/disconnect overhead) ─────

typeset -ga __sw_tcp_result=()

# Args: TYPE field1 field2 ...  Fields are joined with REAL tabs and sent raw
# (print -r) so a literal backslash-t/-n the user typed is preserved; any REAL
# tab/newline (e.g. from a paste) is stripped to a space so it cannot break
# the protocol framing.
__sw_query() {
  __sw_tcp_result=()

  # Neutralize SIGPIPE: writing to a daemon that has idle-exited must return
  # a recoverable error, never raise a signal that freezes the line editor.
  setopt local_options local_traps
  trap '' PIPE

  local -a __sw_fields=()
  local __sw_f
  for __sw_f in "\$@"; do __sw_fields+=("\${__sw_f//[\$'\\t\\n']/ }"); done
  local __sw_req="\${(pj:\\t:)__sw_fields}"

  # (Re)connect if needed — daemon may have idle-exited or restarted
  [[ \$__sw_ready -ne 1 ]] && { __sw_connect || return 1 }

  # Send raw; one transparent reconnect+retry on a stale connection
  if ! print -ru \$__sw_fd -- "\$__sw_req" 2>/dev/null; then
    __sw_connect && print -ru \$__sw_fd -- "\$__sw_req" 2>/dev/null || { __sw_ready=0; return 1 }
  fi

  # Read until the blank-line terminator. A timeout means an incomplete
  # response (slow/dead daemon) — reconnect to drain leftover bytes so the
  # next query cannot read a stale response (protocol desync).
  local __sw_line __sw_got=0
  while IFS= read -r -t 0.2 -u \$__sw_fd __sw_line 2>/dev/null; do
    [[ -z "\$__sw_line" ]] && { __sw_got=1; break }
    __sw_tcp_result+=("\$__sw_line")
  done
  [[ \$__sw_got -eq 1 ]] || { __sw_connect; return 1 }

  [[ \${#__sw_tcp_result} -gt 0 ]]
}

# ─── Command Capture (auto-save) ───────────────────────────

__sw_preexec() {
  export __SW_START_TIME=\$EPOCHREALTIME
  export __SW_COMMAND="\$1"
}

__sw_precmd() {
  local exit_code=\$?
  if [[ -n "\$__SW_COMMAND" ]]; then
    local duration=0
    if [[ -n "\$__SW_START_TIME" ]]; then
      duration=\$(( (EPOCHREALTIME - __SW_START_TIME) * 1000 ))
      duration=\${duration%%.*}
    fi

    # Save via persistent TCP (instant). On failure, restart a dead daemon
    # (a fork between commands is fine) so the next keystroke can reconnect,
    # and fall back to a direct write for this command.
    if ! __sw_query ADD "\$__SW_COMMAND" "\$PWD" "\$exit_code" "\$duration" "\$SW_SESSION_ID" zsh; then
      __sw_daemon_alive || command ${bin} daemon start &>/dev/null &!
      command ${bin} add \\
        --command "\$__SW_COMMAND" \\
        --cwd "\$PWD" \\
        --exit-code "\$exit_code" \\
        --duration "\$duration" \\
        --session "\$SW_SESSION_ID" \\
        --shell "zsh" &!
    fi

    # Show update notice if available
    local __sw_line
    for __sw_line in "\${__sw_tcp_result[@]}"; do
      if [[ "\$__sw_line" == UPDATE$'\\t'* ]]; then
        print -P "%F{yellow}\${__sw_line#UPDATE	}%f"
      fi
    done

    unset __SW_COMMAND __SW_START_TIME
  fi
}

# ─── Render dropdown ───────────────────────────────────────

__sw_render() {
  POSTDISPLAY=""
  region_highlight=()

  [[ \${#__sw_suggestions} -eq 0 ]] && return

  local buf_len=\${#BUFFER}
  local offset=\$buf_len

  local i
  for (( i=1; i<=\${#__sw_suggestions}; i++ )); do
    local item="\${__sw_suggestions[\$i]}"
    local marker="  "
    if [[ \$(( i - 1 )) -eq \$__sw_selected ]]; then
      marker="› "
    fi
    local line=\$'\\n'"  \${marker}\${item}"
    local start=\$offset
    POSTDISPLAY+="\$line"
    offset=\$(( offset + \${#line} ))

    if [[ \$(( i - 1 )) -eq \$__sw_selected ]]; then
      region_highlight+=("\$start \$offset fg=cyan,bold")
    else
      region_highlight+=("\$start \$offset fg=245")
    fi
  done
}

# ─── Auto-suggest (zero-fork, never blocks typing) ───────

__sw_suggest() {
  [[ "\$BUFFER" == "\$__sw_prev_buffer" ]] && return
  __sw_prev_buffer="\$BUFFER"
  # -1 = cursor on the typed line, no item selected yet (Enter runs BUFFER).
  # Tab moves into the list (0 = first item).
  __sw_selected=-1
  __sw_suggestions=()
  POSTDISPLAY=""
  region_highlight=()

  [[ \${#BUFFER} -lt 2 ]] && return

  # Socket query only — no fallback, never spawn process during typing
  __sw_query SUGGEST "\$BUFFER" 5 || return

  __sw_suggestions=("\${__sw_tcp_result[@]}")
  __sw_render
}

# ─── Widget wrappers (trigger suggest on keystroke) ────────

__sw_self_insert() {
  zle .self-insert
  __sw_suggest
}

__sw_backward_delete_char() {
  zle .backward-delete-char
  __sw_suggest
}

__sw_backward_kill_word() {
  zle .backward-kill-word
  __sw_suggest
}

# ─── Tab: next result ──────────────────────────────────────

__sw_next() {
  if [[ \${#__sw_suggestions} -gt 0 ]]; then
    __sw_selected=\$(( (__sw_selected + 1) % \${#__sw_suggestions} ))
    __sw_render
  else
    zle expand-or-complete
  fi
}

# ─── Shift+Tab: previous result ────────────────────────────

__sw_prev() {
  if [[ \${#__sw_suggestions} -gt 0 ]]; then
    if [[ \$__sw_selected -lt 0 ]]; then
      # From the typed line, Shift+Tab wraps to the last item
      __sw_selected=\$(( \${#__sw_suggestions} - 1 ))
    else
      __sw_selected=\$(( (__sw_selected - 1 + \${#__sw_suggestions}) % \${#__sw_suggestions} ))
    fi
    __sw_render
  else
    zle .reverse-menu-complete
  fi
}

# ─── Enter: accept selected or execute ─────────────────────

__sw_accept_line() {
  # Only replace BUFFER when the user has actually moved into the list
  # (Tab/Shift+Tab → __sw_selected >= 0). With nothing selected, Enter runs
  # exactly what was typed.
  if [[ \${#__sw_suggestions} -gt 0 && \$__sw_selected -ge 0 ]]; then
    BUFFER="\${__sw_suggestions[\$(( __sw_selected + 1 ))]}"
    CURSOR=\${#BUFFER}
  fi
  POSTDISPLAY=""
  region_highlight=()
  __sw_suggestions=()
  __sw_prev_buffer="\$BUFFER"
  zle .accept-line
}

# ─── Escape: clear suggestions ─────────────────────────────

__sw_dismiss() {
  if [[ \${#__sw_suggestions} -gt 0 ]]; then
    POSTDISPLAY=""
    region_highlight=()
    __sw_suggestions=()
    __sw_prev_buffer="\$BUFFER"
  else
    zle .send-break
  fi
}

# ─── Right arrow: accept top suggestion inline ─────────────

__sw_forward_char() {
  if [[ \${#__sw_suggestions} -gt 0 && \$CURSOR -eq \${#BUFFER} ]]; then
    # Accept inline: nothing selected yet → take the top item (index 1)
    local idx=\$(( __sw_selected < 0 ? 1 : __sw_selected + 1 ))
    BUFFER="\${__sw_suggestions[\$idx]}"
    CURSOR=\${#BUFFER}
    POSTDISPLAY=""
    region_highlight=()
    __sw_suggestions=()
    __sw_prev_buffer="\$BUFFER"
  else
    zle .forward-char
  fi
}

# ─── Ctrl+R: full interactive search ───────────────────────

__sw_search_widget() {
  POSTDISPLAY=""
  region_highlight=()
  __sw_suggestions=()
  local selected
  selected="\$(command ${bin} search --query "\$LBUFFER" </dev/tty 2>/dev/tty)"
  local ret=\$?
  if [[ \$ret -eq 0 && -n "\$selected" ]]; then
    BUFFER="\$selected"
    CURSOR=\${#BUFFER}
  fi
  __sw_prev_buffer="\$BUFFER"
  zle reset-prompt
}

# ─── Register widgets & bindings ───────────────────────────

zle -N self-insert __sw_self_insert
zle -N backward-delete-char __sw_backward_delete_char
zle -N backward-kill-word __sw_backward_kill_word
zle -N __sw_next
zle -N __sw_prev
zle -N __sw_accept_line
zle -N __sw_dismiss
zle -N __sw_forward_char
zle -N __sw_search_widget

autoload -Uz add-zsh-hook
add-zsh-hook preexec __sw_preexec
add-zsh-hook precmd __sw_precmd

bindkey '^R' __sw_search_widget
bindkey '\\t' __sw_next
bindkey '^[[Z' __sw_prev
bindkey '^M' __sw_accept_line
bindkey '^[' __sw_dismiss
bindkey '^[[C' __sw_forward_char
bindkey '^[OC' __sw_forward_char
`;
}

function generateBashScript(bin: string): string {
  return `
# --- shellwise shell integration ---

export SW_SESSION_ID="\$(command uuidgen 2>/dev/null || echo "\$\$-\$RANDOM")"

# ─── Command Capture ───────────────────────────────────────

__sw_preexec() {
  export __SW_START_TIME=\$SECONDS
  export __SW_COMMAND="\$(HISTTIMEFORMAT= history 1 | sed 's/^[ ]*[0-9]*[ ]*//')"
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
