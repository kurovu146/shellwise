export interface InitOptions {
  /**
   * Remote mode: the script runs on a host where shellwise is NOT installed,
   * talking to a socket forwarded back to the local daemon (see `sw ssh`).
   * Everything that shells out to the binary is dropped.
   */
  remote?: boolean;
}

export function generateZshScript(bin: string, opts: InitOptions = {}): string {
  const remote = opts.remote === true;

  // Remote: the socket path is handed down by `sw ssh` via the environment,
  // because the forwarded socket lives at a per-session path on the remote /tmp.
  const socketLine = remote
    ? `typeset -g __sw_sock="\${SHELLWISE_SOCKET}"`
    : `typeset -g __sw_sock="/tmp/shellwise-\${UID}.sock"`;

  // Remote: no binary to spawn and no pid file to inspect — just connect.
  const bootstrap = remote
    ? `zmodload zsh/net/socket 2>/dev/null && __sw_connect`
    : `zmodload zsh/net/socket 2>/dev/null && {
  if [[ ! -S "\$__sw_sock" ]]; then
    # Start daemon in background (non-blocking)
    command ${bin} daemon start &>/dev/null &!
    sleep 0.3
  fi
  __sw_connect
}`;

  const daemonAlive = remote
    ? ""
    : `# Is the daemon process alive? No fork (kill -0 + \$(<file) are builtins).
__sw_daemon_alive() {
  local pf="/tmp/shellwise-\${UID}.pid"
  [[ -f "\$pf" ]] || return 1
  local lines=("\${(@f)\$(<\$pf)}")
  kill -0 \${lines[1]:-0} 2>/dev/null
}
`;

  // Remote: a failed ADD is simply dropped. There is no binary to fall back to,
  // and the forwarded socket may be read-only anyway.
  const addCommand = remote
    ? `    __sw_query ADD "\$__SW_COMMAND" "\$PWD" "\$exit_code" "\$duration" "\$SW_SESSION_ID" zsh || true`
    : `    # Save via persistent TCP (instant). On failure, restart a dead daemon
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
    fi`;

  // Remote: Ctrl+R opens the TUI, which is a binary. Leave the key alone so the
  // host's own history search keeps working.
  const searchWidget = remote
    ? ""
    : `# ─── Ctrl+R: full interactive search ───────────────────────

__sw_search_widget() {
  POSTDISPLAY=""
  region_highlight=()
  __sw_suggestions=()
  __sw_sources=()
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
`;

  const searchRegistration = remote ? "" : `zle -N __sw_search_widget\n`;
  const searchBinding = remote ? "" : `bindkey '^R' __sw_search_widget\n`;

  return `
# --- shellwise shell integration ---

# Session tracking
export SW_SESSION_ID="\$(command uuidgen 2>/dev/null || echo "\$\$-\$RANDOM")"

# An older release exported these, so a parent shell may still be leaking them
# into this one. Drop them before the first prompt, or this shell would record
# whatever the parent was running.
unset __SW_COMMAND __SW_START_TIME

# State
typeset -g __sw_prev_buffer=""
typeset -ga __sw_suggestions=()
typeset -ga __sw_sources=()
typeset -g __sw_original=""
typeset -g __sw_selected=0
typeset -g __sw_fd=""
typeset -g __sw_ready=0
# ─── Daemon connection (self-healing, Unix socket) ─────────
# Unix-domain socket: protected by filesystem permissions (0600), unlike a
# guessable localhost TCP port with no auth. The daemon idle-exits after
# inactivity, so the shell must reconnect on demand — otherwise a long-idle
# pane loses suggest forever.

${socketLine}

${daemonAlive}
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
${bootstrap}

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
  # Shell-local, never exported: an exported value is inherited by every child
  # shell, which would then save the parent's command again on its first
  # prompt — with the child's cwd and session id.
  typeset -g __SW_START_TIME=\$EPOCHREALTIME
  typeset -g __SW_COMMAND="\$1"
}

__sw_precmd() {
  local exit_code=\$?
  if [[ -n "\$__SW_COMMAND" ]]; then
    local duration=0
    if [[ -n "\$__SW_START_TIME" ]]; then
      duration=\$(( (EPOCHREALTIME - __SW_START_TIME) * 1000 ))
      duration=\${duration%%.*}
    fi

${addCommand}

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

  local cols=\${COLUMNS:-80}
  # zsh reports 0 columns when there is no tty (scripts, some multiplexers).
  (( cols < 1 )) && cols=80
  local offset=\${#BUFFER}
  local i line start

  # Too narrow for a frame: plain list, same as it always was.
  if (( cols < 24 )); then
    for (( i=1; i<=\${#__sw_suggestions}; i++ )); do
      local marker="  "
      (( i - 1 == __sw_selected )) && marker="› "
      line=\$'\\n'"  \${marker}\${__sw_suggestions[\$i]}"
      start=\$offset
      POSTDISPLAY+="\$line"
      offset=\$(( offset + \${#line} ))
      if (( i - 1 == __sw_selected )); then
        region_highlight+=("\$start \$offset fg=cyan,bold")
      else
        region_highlight+=("\$start \$offset fg=245")
      fi
    done
    return
  fi

  local show_tag=1
  (( cols < 40 )) && show_tag=0

  local box=\$(( cols - 4 ))
  local inner=\$(( box - 2 ))
  local cmd_max
  if (( show_tag )); then
    # 2 padding + 2 marker + 1 gap + 7 tag
    cmd_max=\$(( inner - 12 ))
  else
    cmd_max=\$(( inner - 4 ))
  fi

  local bar="\${(l:\$inner::─:)}"

  line=\$'\\n'"  ╭\${bar}╮"
  start=\$offset
  POSTDISPLAY+="\$line"
  offset=\$(( offset + \${#line} ))
  region_highlight+=("\$start \$offset fg=240")

  for (( i=1; i<=\${#__sw_suggestions}; i++ )); do
    local cmd="\${__sw_suggestions[\$i]}"
    local src="\${__sw_sources[\$i]}"
    local marker="  "
    (( i - 1 == __sw_selected )) && marker="› "

    # Pad by display width — a CJK glyph or emoji eats two columns.
    local w=\${(m)#cmd}
    if (( w > cmd_max )); then
      # Elide the middle, not the tail: commands that share a long prefix
      # differ at the end (flags, paths, branch names), and that is what has
      # to stay visible.
      local head_w=\$(( (cmd_max - 1) / 2 ))
      local head_s="\${cmd[1,\$head_w]}"
      while (( \${(m)#head_s} > head_w )); do head_s="\${head_s[1,-2]}"; done
      local tail_w=\$(( cmd_max - 1 - \${(m)#head_s} ))
      local tail_s="\${cmd[-\$tail_w,-1]}"
      while (( \${(m)#tail_s} > tail_w )); do tail_s="\${tail_s[2,-1]}"; done
      cmd="\${head_s}…\${tail_s}"
      w=\${(m)#cmd}
    fi
    local pad=\$(( cmd_max - w ))
    local spaces=""
    (( pad > 0 )) && spaces="\${(l:\$pad:)}"

    local tag=""
    (( show_tag )) && tag=" \${(l:7:)src}"

    line=\$'\\n'"  │ \${marker}\${cmd}\${spaces}\${tag} │"
    start=\$offset
    POSTDISPLAY+="\$line"
    offset=\$(( offset + \${#line} ))

    # Highlight offsets count characters, not columns: "\\n  │ " is 5 of them.
    local s2=\$(( start + 5 ))
    local s3=\$(( s2 + 2 + \${#cmd} + pad ))
    region_highlight+=("\$start \$s2 fg=240")
    if (( i - 1 == __sw_selected )); then
      region_highlight+=("\$s2 \$s3 fg=cyan,bold")
    else
      region_highlight+=("\$s2 \$s3 fg=245")
    fi
    if (( show_tag )); then
      region_highlight+=("\$s3 \$(( s3 + 1 )) fg=240")
      if [[ "\$src" == history ]]; then
        region_highlight+=("\$(( s3 + 1 )) \$(( s3 + 8 )) fg=108")
      elif [[ "\$src" == common ]]; then
        region_highlight+=("\$(( s3 + 1 )) \$(( s3 + 8 )) fg=110")
      else
        region_highlight+=("\$(( s3 + 1 )) \$(( s3 + 8 )) fg=240")
      fi
      region_highlight+=("\$(( s3 + 8 )) \$offset fg=240")
    else
      region_highlight+=("\$s3 \$offset fg=240")
    fi
  done

  line=\$'\\n'"  ╰\${bar}╯"
  start=\$offset
  POSTDISPLAY+="\$line"
  offset=\$(( offset + \${#line} ))
  region_highlight+=("\$start \$offset fg=240")
}

# ─── Auto-suggest (zero-fork, never blocks typing) ───────

__sw_suggest() {
  [[ "\$BUFFER" == "\$__sw_prev_buffer" ]] && return
  __sw_prev_buffer="\$BUFFER"
  # -1 = cursor on the typed line, no item selected yet (Enter runs BUFFER).
  # Tab moves into the list (0 = first item).
  __sw_selected=-1
  __sw_suggestions=()
  __sw_sources=()
  __sw_original="\$BUFFER"
  POSTDISPLAY=""
  region_highlight=()

  [[ \${#BUFFER} -lt 2 ]] && return

  # Socket query only — no fallback, never spawn process during typing.
  # "v2" asks the daemon to say where each suggestion came from.
  __sw_query SUGGEST "\$BUFFER" 5 v2 || return

  local __sw_line
  for __sw_line in "\${__sw_tcp_result[@]}"; do
    if [[ "\$__sw_line" == *\$'\\t'* ]]; then
      __sw_sources+=("\${__sw_line%%\$'\\t'*}")
      __sw_suggestions+=("\${__sw_line#*\$'\\t'}")
    else
      # Daemon predates v2: render the row without a tag.
      __sw_sources+=("")
      __sw_suggestions+=("\$__sw_line")
    fi
  done

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

# ─── Selection → input line ────────────────────────────────

# Tab writes the highlighted command straight into the line, so what you see is
# what Enter runs. Index -1 means "the text you typed".
__sw_apply_selection() {
  if [[ \$__sw_selected -ge 0 ]]; then
    BUFFER="\${__sw_suggestions[\$(( __sw_selected + 1 ))]}"
  else
    BUFFER="\$__sw_original"
  fi
  CURSOR=\${#BUFFER}
  # Our own edit — don't let it look like typing and trigger a fresh query.
  __sw_prev_buffer="\$BUFFER"
  __sw_render
}

# ─── Tab: next result ──────────────────────────────────────

__sw_next() {
  if [[ \${#__sw_suggestions} -gt 0 ]]; then
    __sw_selected=\$(( __sw_selected + 1 ))
    (( __sw_selected >= \${#__sw_suggestions} )) && __sw_selected=-1
    __sw_apply_selection
  else
    zle expand-or-complete
  fi
}

# ─── Shift+Tab: previous result ────────────────────────────

__sw_prev() {
  if [[ \${#__sw_suggestions} -gt 0 ]]; then
    __sw_selected=\$(( __sw_selected - 1 ))
    (( __sw_selected < -1 )) && __sw_selected=\$(( \${#__sw_suggestions} - 1 ))
    __sw_apply_selection
  else
    zle .reverse-menu-complete
  fi
}

# ─── Enter: accept selected or execute ─────────────────────

__sw_accept_line() {
  # BUFFER already holds whatever is highlighted — Tab put it there — so Enter
  # runs exactly what the line shows.
  POSTDISPLAY=""
  region_highlight=()
  __sw_suggestions=()
  __sw_sources=()
  __sw_prev_buffer="\$BUFFER"
  zle .accept-line
}

# ─── Escape: clear suggestions ─────────────────────────────

__sw_dismiss() {
  if [[ \${#__sw_suggestions} -gt 0 ]]; then
    # Close the frame, keep the command Tab filled in so it can be edited.
    POSTDISPLAY=""
    region_highlight=()
    __sw_suggestions=()
    __sw_sources=()
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
    __sw_sources=()
    __sw_prev_buffer="\$BUFFER"
  else
    zle .forward-char
  fi
}

${searchWidget}
# ─── Register widgets & bindings ───────────────────────────

zle -N self-insert __sw_self_insert
zle -N backward-delete-char __sw_backward_delete_char
zle -N backward-kill-word __sw_backward_kill_word
zle -N __sw_next
zle -N __sw_prev
zle -N __sw_accept_line
zle -N __sw_dismiss
zle -N __sw_forward_char
${searchRegistration}
autoload -Uz add-zsh-hook
add-zsh-hook preexec __sw_preexec
add-zsh-hook precmd __sw_precmd

${searchBinding}bindkey '\\t' __sw_next
bindkey '^[[Z' __sw_prev
bindkey '^M' __sw_accept_line
bindkey '^[' __sw_dismiss
bindkey '^[[C' __sw_forward_char
bindkey '^[OC' __sw_forward_char
`;
}
