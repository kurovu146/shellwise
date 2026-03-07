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

# Load TCP module + connect at shell startup
zmodload zsh/net/tcp 2>/dev/null && {
  # Read daemon port from PID file
  local __sw_pidfile="/tmp/shellwise-\${UID}.pid"
  if [[ ! -f "\$__sw_pidfile" ]]; then
    # Start daemon in background (non-blocking)
    command ${bin} daemon start &>/dev/null &!
    sleep 0.3
  fi
  if [[ -f "\$__sw_pidfile" ]]; then
    local __sw_port=\${"\$(sed -n 2p "\$__sw_pidfile")":-0}
    if [[ \$__sw_port -gt 0 ]]; then
      ztcp 127.0.0.1 \$__sw_port 2>/dev/null && {
        __sw_fd=\$REPLY
        __sw_ready=1
      }
    fi
  fi
}

# ─── Persistent TCP query (no connect/disconnect overhead) ─

typeset -ga __sw_tcp_result=()

__sw_tcp_query() {
  __sw_tcp_result=()
  [[ \$__sw_ready -ne 1 ]] && return 1

  # Send request
  print -u \$__sw_fd "\$1" 2>/dev/null || {
    # Connection broken — mark unavailable
    __sw_ready=0
    return 1
  }

  # Read response lines until empty line
  local line
  while IFS= read -r -t 0.1 -u \$__sw_fd line 2>/dev/null; do
    [[ -z "\$line" ]] && break
    __sw_tcp_result+=("\$line")
  done

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

    # Save via persistent TCP (instant) or fallback to background process
    __sw_tcp_query "ADD\\t\$__SW_COMMAND\\t\$PWD\\t\$exit_code\\t\$duration\\t\$SW_SESSION_ID\\tzsh" || \\
      command ${bin} add \\
        --command "\$__SW_COMMAND" \\
        --cwd "\$PWD" \\
        --exit-code "\$exit_code" \\
        --duration "\$duration" \\
        --session "\$SW_SESSION_ID" \\
        --shell "zsh" &!

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
  __sw_selected=0
  __sw_suggestions=()
  POSTDISPLAY=""
  region_highlight=()

  [[ \${#BUFFER} -lt 2 ]] && return

  # TCP query only — no fallback, never spawn process during typing
  __sw_tcp_query "SUGGEST\\t\$BUFFER\\t5" || return

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
    __sw_selected=\$(( (__sw_selected - 1 + \${#__sw_suggestions}) % \${#__sw_suggestions} ))
    __sw_render
  else
    zle .reverse-menu-complete
  fi
}

# ─── Enter: accept selected or execute ─────────────────────

__sw_accept_line() {
  if [[ \${#__sw_suggestions} -gt 0 ]]; then
    BUFFER="\${__sw_suggestions[\$(( __sw_selected + 1 ))]}"
    CURSOR=\${#BUFFER}
    POSTDISPLAY=""
    region_highlight=()
    __sw_suggestions=()
    __sw_prev_buffer="\$BUFFER"
  else
    zle .accept-line
  fi
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
    BUFFER="\${__sw_suggestions[\$(( __sw_selected + 1 ))]}"
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
