# Recording for assets/demo.gif — run through scripts/demo-record.sh, which
# builds the isolated environment and points the daemon at it first.
#
# VHS does not load the fake HOME's .zshrc (it uses its own ZDOTDIR), so the
# hidden block below sources it by hand before anything is shown.

Output assets/demo.gif

Set Shell zsh
Set FontSize 17
Set Width 1100
Set Height 620
Set Padding 24
Set TypingSpeed 90ms
Set Theme "Catppuccin Mocha"

Hide
Type "export HOME=/tmp/shellwise-demo/home XDG_DATA_HOME=/tmp/shellwise-demo/data"
Enter
Type "cd /tmp/shellwise-demo/repo && source $HOME/.zshrc && clear"
Enter
Sleep 1s
Show

Sleep 800ms

# A ranked dropdown appears while typing — no keybind needed.
Type "git st"
Sleep 2s

# Tab steps into the list and fills the line, so what you see is what runs.
Tab
Sleep 1.2s
Tab
Sleep 1.2s
Tab
Sleep 1.2s

# Back to the top choice, then run it.
Tab
Sleep 800ms
Tab
Sleep 1.2s
Enter
Sleep 2.5s

# Built-in common commands show up even without history, tagged as such.
Type "docker comp"
Sleep 2.5s
Escape
Sleep 500ms
Ctrl+C
Sleep 800ms

# Ctrl+R for full-screen fuzzy search over everything.
Ctrl+R
Sleep 1.5s
Type "logs"
Sleep 2s
Enter
Sleep 2.5s
