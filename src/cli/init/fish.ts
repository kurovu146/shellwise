export function generateFishScript(bin: string): string {
  return `
# --- shellwise shell integration (fish) ---

set -g SW_SESSION_ID (command uuidgen 2>/dev/null; or echo \$fish_pid-(random))

# State
set -g __sw_suggestions
set -g __sw_sources
set -g __sw_selected -1
set -g __sw_original ""
set -g __sw_drawn 0

# SHELLWISE_SOCKET lets a caller point the integration at another daemon —
# the same escape hatch zsh remote mode uses, and what the tests rely on to
# stay away from the user's real daemon.
if set -q SHELLWISE_SOCKET
    set -g __sw_sock \$SHELLWISE_SOCKET
else
    set -g __sw_sock "/tmp/shellwise-"(id -u)".sock"
end

# Everything with a side effect lives behind this guard: sourcing the script
# non-interactively (what the tests do) must never start a daemon or rebind a
# key. Function definitions stay outside so tests can still call them.
if status is-interactive
    if not test -S \$__sw_sock
        command ${bin} daemon start &>/dev/null &
        disown
    end
end

# ─── Transport ─────────────────────────────────────────────
# fish has no socket builtin, so every query goes through one external
# process. nc costs ~4.5ms — the only option fast enough to run on each
# keystroke. Probe once at startup, never per query.

if command -q nc
    set -g __sw_transport nc
else if command -q socat
    set -g __sw_transport socat
else
    set -g __sw_transport none
end

# Send one protocol line, print the reply. Returns 1 when there is no
# transport, so callers can bail without printing anything.
function __sw_send --argument-names msg
    switch \$__sw_transport
        case nc
            printf '%s\\n' \$msg | command nc -U \$__sw_sock 2>/dev/null
        case socat
            printf '%s\\n' \$msg | command socat - UNIX-CONNECT:\$__sw_sock 2>/dev/null
        case '*'
            return 1
    end
end

# ─── Suggest ───────────────────────────────────────────────

function __sw_suggest --argument-names buf
    set -g __sw_suggestions
    set -g __sw_sources
    set -g __sw_selected -1
    set -g __sw_original \$buf

    # Under two characters there is nothing worth ranking. Over 200 means a
    # terminal pushed raw text at us character by character (real pastes use
    # bracketed paste and never reach here) — querying per character would
    # stall the shell.
    set -l len (string length -- \$buf)
    test \$len -ge 2; or return
    test \$len -le 200; or return

    # Built with printf, not a quoted string: fish leaves \\t alone inside
    # quotes, which would send a literal backslash-t and desync the protocol.
    set -l reply (__sw_send (printf 'SUGGEST\\t%s\\t5\\tv2' \$buf))
    or return

    for line in \$reply
        test -n "\$line"; or continue
        # Source comes first, split on the first tab only, so a tab inside the
        # command keeps the rest of the line intact. Note \\t only means a tab
        # when unquoted — fish does not expand it inside quotes.
        set -l parts (string split -m1 \\t -- \$line)
        if test (count \$parts) -eq 2
            set -a __sw_sources \$parts[1]
            set -a __sw_suggestions \$parts[2]
        else
            # Daemon predates v2: render the row without a tag.
            set -a __sw_sources ""
            set -a __sw_suggestions \$line
        end
    end
end

# ─── Selection ─────────────────────────────────────────────
# Index -1 means "the text you typed".

function __sw_selection_text
    if test \$__sw_selected -ge 0
        echo \$__sw_suggestions[(math \$__sw_selected + 1)]
    else
        echo \$__sw_original
    end
end

function __sw_cycle --argument-names dir
    set -l n (count \$__sw_suggestions)
    test \$n -gt 0; or return

    if test \$dir = next
        set -g __sw_selected (math \$__sw_selected + 1)
        test \$__sw_selected -ge \$n; and set -g __sw_selected -1
    else
        set -g __sw_selected (math \$__sw_selected - 1)
        test \$__sw_selected -lt -1; and set -g __sw_selected (math \$n - 1)
    end
end

function __sw_reset
    set -g __sw_suggestions
    set -g __sw_sources
    set -g __sw_selected -1
    set -g __sw_drawn 0
end

# ─── Draw / clear ──────────────────────────────────────────
# fish has no POSTDISPLAY, so the frame is written below the prompt by hand:
# wipe from the cursor down, print the box, then walk back up and let fish
# repaint the prompt line over what was erased.

function __sw_draw
    set -l lines (__sw_box_lines \$COLUMNS)
    if test (count \$lines) -eq 0
        __sw_clear
        return
    end
    printf '\\e[J'
    for l in \$lines
        printf '\\n%s' \$l
    end
    printf '\\e[%dA\\r' (count \$lines)
    set -g __sw_drawn 1
    commandline -f repaint
end

function __sw_clear
    if test \$__sw_drawn -eq 1
        printf '\\e[J'
        set -g __sw_drawn 0
        commandline -f repaint
    end
end

# ─── Frame ─────────────────────────────────────────────────
# Prints the frame to stdout. Touches neither the cursor nor \`commandline\`,
# so it can be called outside an interactive session — that is what makes it
# testable.

function __sw_box_lines --argument-names cols
    set -l n (count \$__sw_suggestions)
    test \$n -gt 0; or return

    # fish reports 0 columns when there is no tty.
    test \$cols -lt 1; and set cols 80

    if test \$cols -lt 24
        for i in (seq \$n)
            set -l marker "  "
            test (math \$i - 1) -eq \$__sw_selected; and set marker "› "
            echo "  \$marker\$__sw_suggestions[\$i]"
        end
        return
    end

    set -l show_tag 1
    test \$cols -lt 40; and set show_tag 0

    set -l inner (math \$cols - 6)
    set -l cmd_max
    if test \$show_tag -eq 1
        # 2 padding + 2 marker + 1 gap + 7 tag
        set cmd_max (math \$inner - 12)
    else
        set cmd_max (math \$inner - 4)
    end

    set -l bar (string repeat -n \$inner "─")
    echo (set_color 585858)"  ╭\$bar╮"(set_color normal)

    for i in (seq \$n)
        set -l cmd \$__sw_suggestions[\$i]
        set -l src ""
        test (count \$__sw_sources) -ge \$i; and set src \$__sw_sources[\$i]
        set -l marker "  "
        test (math \$i - 1) -eq \$__sw_selected; and set marker "› "

        # Measure by display width — a CJK glyph or emoji eats two columns.
        set -l w (string length --visible -- \$cmd)
        if test \$w -gt \$cmd_max
            # Elide the middle: commands sharing a long prefix differ at the end
            # (flags, paths, branch names), and that is what has to stay visible.
            set -l head_w (math "floor((\$cmd_max - 1) / 2)")
            set -l head_s (string sub -s 1 -l \$head_w -- \$cmd)
            while test (string length --visible -- \$head_s) -gt \$head_w
                set head_s (string sub -s 1 -l (math (string length -- \$head_s) - 1) -- \$head_s)
            end
            set -l tail_w (math \$cmd_max - 1 - (string length --visible -- \$head_s))
            set -l tail_s (string sub -s -\$tail_w -- \$cmd)
            while test (string length --visible -- \$tail_s) -gt \$tail_w
                set tail_s (string sub -s 2 -- \$tail_s)
            end
            set cmd "\$head_s…\$tail_s"
            set w (string length --visible -- \$cmd)
        end

        set -l pad (math \$cmd_max - \$w)
        set -l spaces ""
        test \$pad -gt 0; and set spaces (string repeat -n \$pad " ")

        set -l cmd_color (set_color 8a8a8a)
        test (math \$i - 1) -eq \$__sw_selected; and set cmd_color (set_color -o cyan)

        set -l tag ""
        if test \$show_tag -eq 1
            set -l tag_color (set_color 585858)
            test "\$src" = history; and set tag_color (set_color 87af87)
            test "\$src" = common; and set tag_color (set_color 87afd7)
            set tag " \$tag_color"(string pad -w 7 -- \$src)(set_color 585858)
        end

        echo (set_color 585858)"  │ "\$cmd_color"\$marker\$cmd\$spaces"(set_color 585858)"\$tag │"(set_color normal)
    end

    echo (set_color 585858)"  ╰\$bar╯"(set_color normal)
end

# ─── Widgets ───────────────────────────────────────────────

function __sw_insert --argument-names c
    commandline -i -- \$c
    __sw_suggest (commandline)
    __sw_draw
end

function __sw_backspace
    commandline -f backward-delete-char
    __sw_suggest (commandline)
    __sw_draw
end

# Tab / Shift+Tab write the highlighted command straight into the line, so
# what you see is what Enter runs.
function __sw_accept
    if test (count \$__sw_suggestions) -eq 0
        commandline -f complete
        return
    end
    __sw_cycle next
    commandline -r -- (__sw_selection_text)
    __sw_draw
end

function __sw_accept_prev
    if test (count \$__sw_suggestions) -eq 0
        commandline -f complete-and-search
        return
    end
    __sw_cycle prev
    commandline -r -- (__sw_selection_text)
    __sw_draw
end

function __sw_forward
    if test (count \$__sw_suggestions) -gt 0
        set -l idx \$__sw_selected
        test \$idx -lt 0; and set idx 0
        set -l picked \$__sw_suggestions[(math \$idx + 1)]
        __sw_clear
        __sw_reset
        commandline -r -- \$picked
    else
        commandline -f forward-char
    end
end

function __sw_dismiss
    if test (count \$__sw_suggestions) -gt 0
        # Close the frame, keep whatever Tab filled in.
        __sw_clear
        __sw_reset
    else
        commandline -f cancel-commandline
    end
end

function __sw_execute
    __sw_clear
    __sw_reset
    commandline -f execute
end

function __sw_search
    __sw_clear
    __sw_reset
    set -l picked (command ${bin} search --query (commandline) </dev/tty 2>/dev/tty)
    if test -n "\$picked"
        commandline -r -- \$picked
    end
    commandline -f repaint
end

# ─── Auto-save ─────────────────────────────────────────────
# fish_postexec hands us the command line, and \$CMD_DURATION is already in ms.

function __sw_postexec --on-event fish_postexec
    set -l st \$status
    test -n "\$argv[1]"; or return
    __sw_clear
    __sw_send (printf 'ADD\\t%s\\t%s\\t%s\\t%s\\t%s\\tfish' \$argv[1] \$PWD \$st \$CMD_DURATION \$SW_SESSION_ID) >/dev/null
    or command ${bin} add --command "\$argv[1]" --cwd "\$PWD" --exit-code \$st --duration \$CMD_DURATION --session "\$SW_SESSION_ID" --shell fish &>/dev/null &
end

# ─── Bindings + first-run notice ───────────────────────────
# Same guard as the daemon block above: sourcing this file in a test must not
# rebind the keyboard.

if status is-interactive
    if test \$__sw_transport = none
        set -l dir (test -n "\$XDG_DATA_HOME"; and echo \$XDG_DATA_HOME/shellwise; or echo \$HOME/.local/share/shellwise)
        if not test -f \$dir/fish-no-transport-warned
            mkdir -p \$dir 2>/dev/null
            touch \$dir/fish-no-transport-warned 2>/dev/null
            echo "shellwise: cài netcat (nc) để bật dropdown gợi ý — Ctrl+R vẫn dùng được"
        end
    end

    for c in (string split '' 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_./~=:@%+,')
        bind -- \$c "__sw_insert '\$c'"
    end
    bind \\x7f __sw_backspace
    bind \\b __sw_backspace
    bind \\t __sw_accept
    bind \\e\\[Z __sw_accept_prev
    bind \\e\\[C __sw_forward
    bind \\eOC __sw_forward
    bind \\e __sw_dismiss
    bind \\r __sw_execute
    bind \\cr __sw_search
end
`;
}
