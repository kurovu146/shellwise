# shellwise

Smart command history with inline auto-suggest and fuzzy search for your terminal.

![License](https://img.shields.io/badge/license-MIT-blue)
![Runtime](https://img.shields.io/badge/runtime-Bun-black)

## Features

- **Auto-save** — commands are recorded automatically after successful execution (exit code 0)
- **Auto-suggest** — inline dropdown appears as you type, no `Ctrl+R` needed
- **Fuzzy search** — `Ctrl+R` opens a full interactive search with real-time filtering
- **Smart ranking** — frecency scoring (frequency x recency) for relevant results
- **Common commands** — suggests popular commands (git, npm, docker, etc.) even with empty history
- **Daemon mode** — persistent background process for sub-millisecond suggest latency (~1-3ms)
- **Zero-fork** — uses `zsh/net/tcp` persistent connection, never spawns a process while typing

## How it works

```
You type:  git s
           ┌─────────────────────────────┐
           │ › git status          (history)
           │   git stash           (history)
           │   git switch main     (history)
           │   git stash pop       (common)
           │   git stash list      (common)
           └─────────────────────────────┘
Tab/Shift+Tab to navigate, Enter to select, Esc to dismiss
```

## Install

```bash
bun install -g shellwise
```

That's it. Shell integration is auto-injected into your `~/.zshrc` or `~/.bashrc` on install. Restart your terminal to activate.

### Manual setup

If auto-setup didn't work, add to your shell config:

```bash
# ~/.zshrc
eval "$(sw init zsh)"

# ~/.bashrc
eval "$(sw init bash)"
```

## Usage

### Auto-suggest (while typing)

Just start typing — suggestions appear automatically after 2+ characters.

| Key | Action |
|-----|--------|
| `Tab` | Next suggestion |
| `Shift+Tab` | Previous suggestion |
| `Enter` | Accept selected suggestion |
| `→` (Right arrow) | Accept suggestion inline |
| `Esc` | Dismiss suggestions |

### Interactive search

Press `Ctrl+R` to open full fuzzy search:

| Key | Action |
|-----|--------|
| Type | Filter results in real-time |
| `↑` / `↓` | Navigate results |
| `Enter` | Accept and paste to command line |
| `Esc` | Cancel |

### Commands

```bash
sw search [--query <text>]     # Interactive fuzzy search (Ctrl+R)
sw suggest --query <text>      # Get top suggestion (used by shell hook)
sw add --command <cmd>         # Save a command to history
sw init <zsh|bash>             # Output shell integration script
sw import [zsh|bash]           # Import existing shell history
sw stats                       # Show usage statistics
sw prune --days <n>            # Remove entries older than n days
sw daemon start|stop|status    # Manage background daemon
```

### Import existing history

```bash
sw import zsh    # Import from ~/.zsh_history
sw import bash   # Import from ~/.bash_history
```

## Architecture

```
┌──────────────┐     TCP (persistent)     ┌──────────────────┐
│   Zsh/Bash   │◄────────────────────────►│   sw daemon      │
│   (shell)    │     ~1-3ms round-trip    │   (Bun process)  │
└──────────────┘                          └────────┬─────────┘
                                                   │
                                          ┌────────▼─────────┐
                                          │   SQLite (WAL)   │
                                          │   history.db     │
                                          └──────────────────┘
```

- **Shell hooks** (`preexec`/`precmd`) capture commands after execution
- **Persistent TCP connection** opened once at shell init, reused for all queries
- **Prepared SQLite statements** pre-warmed at daemon start for instant queries
- **Frecency scoring** = frequency × recency_weight — recent commands rank higher
- **Auto-idle shutdown** — daemon stops after 30 min of inactivity

## Data storage

```
~/.local/share/shellwise/history.db    # SQLite database
~/.config/shellwise/                   # Config (future use)
/tmp/shellwise-<uid>.sock              # Unix socket
/tmp/shellwise-<uid>.pid               # Daemon PID + port
```

## Requirements

- [Bun](https://bun.sh) >= 1.0.0
- Zsh or Bash

## Uninstall

```bash
bun remove -g shellwise
```

Shell integration is automatically removed from your config on uninstall.

## License

MIT
