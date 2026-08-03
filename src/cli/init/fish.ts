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
`;
}
