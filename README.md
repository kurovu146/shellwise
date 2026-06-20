<div align="center">

# ⚡ shellwise

### Your shell history, but smart.

Inline auto-suggest, fuzzy search, and **frecency** ranking for your terminal —
backed by a tiny background daemon so suggestions appear in **~1–3 ms** without ever
forking while you type.

[![npm version](https://img.shields.io/npm/v/shellwise?style=flat-square&color=3fb950&label=npm)](https://www.npmjs.com/package/shellwise)
[![License](https://img.shields.io/badge/license-MIT-3b82f6?style=flat-square)](LICENSE)
[![Runtime](https://img.shields.io/badge/runtime-Bun-000000?style=flat-square&logo=bun&logoColor=white)](https://bun.sh)
[![Shell](https://img.shields.io/badge/shell-zsh%20%7C%20bash-89e051?style=flat-square)](#-requirements)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-8b949e?style=flat-square)](#-requirements)

[Install](#-install) · [Features](#-features) · [Usage](#-usage) · [How it works](#-how-it-works)

</div>

---

```text
  $ git s▏
  ┌──────────────────────────────────────────────┐
  │ › git status                        history   │   ← ranked by frecency
  │   git switch main                   history   │     (how often × how recently)
  │   git stash pop                     history   │
  │   git stash list                    common    │   ← popular fallbacks
  │   git show                          common    │
  └──────────────────────────────────────────────┘
   Tab/⇧Tab navigate · → accept inline · Enter run · Esc dismiss
```

> **Enter always runs what *you* typed.** Suggestions never hijack your command —
> press `Tab` to step into the list only when you actually want one.

## Why shellwise?

- 🧠 **Suggestions that learn you** — your real history, ranked by **frecency** (frequency × recency), so the commands you actually use float to the top and stale ones fade.
- ⚡ **Instant, zero-fork** — a persistent daemon answers every keystroke in ~1–3 ms over a Unix socket. No subprocess is ever spawned while you type.
- ⌨️ **No `Ctrl+R` required** — see matches inline as you type. (`Ctrl+R` is still there for full-screen fuzzy search when you want it.)
- 🔒 **Private & local** — everything lives in a SQLite file on your machine, reached through a `0600` Unix socket. Nothing leaves your computer.
- 📦 **Zero config** — one install, shell integration auto-injected, done.

## ✨ Features

| | |
|---|---|
| **Auto-save** | Commands recorded automatically after a successful run (exit code 0). |
| **Inline auto-suggest** | Dropdown appears as you type — no keybind needed. *(zsh)* |
| **Fuzzy search** | `Ctrl+R` opens a full interactive search with real-time filtering. *(zsh + bash)* |
| **Frecency ranking** | Frequency × recency, computed at query time — recent commands rank higher and decay naturally. |
| **Common commands** | Suggests popular commands (`git`, `npm`, `docker`, …) even with empty history. |
| **Daemon mode** | Persistent background process keeps suggest latency at ~1–3 ms, idles out after 30 min. |
| **Safe & self-healing** | Reconnects automatically if the daemon restarts; preserves your command verbatim, even with `\t`/`\n`. |

## 📦 Install

> **This is a CLI tool — install it globally.**

```bash
# Homebrew (recommended)
brew install kurovu146/tap/shellwise

# Bun
bun install -g shellwise

# npm
npm install -g shellwise
```

Shell integration is auto-injected into your `~/.zshrc` or `~/.bashrc`.
**Open a new terminal** (or `source` your rc file) to activate.

<details>
<summary>Manual setup (if auto-inject didn't run)</summary>

```bash
# ~/.zshrc
eval "$(shellwise init zsh)"

# ~/.bashrc
eval "$(shellwise init bash)"
```

</details>

## 🚀 Usage

Just start typing. After 2+ characters, suggestions from your history appear inline.

### While typing *(zsh)*

| Key | Action |
|-----|--------|
| `Enter` | **Run the command you typed** (or the highlighted suggestion, if you navigated into the list) |
| `Tab` | Step into the list / next suggestion |
| `Shift+Tab` | Previous suggestion |
| `→` Right arrow | Accept the top suggestion inline (fills the line — doesn't run it) |
| `Esc` | Dismiss suggestions |

### Interactive search *(`Ctrl+R`)*

| Key | Action |
|-----|--------|
| *type* | Filter results in real time |
| `↑` / `↓` | Navigate results |
| `Enter` | Paste the selected command to your prompt |
| `Esc` | Cancel |

## 🔧 Commands

Both `shellwise` and the short alias `sw` work:

```bash
sw search [--query <text>]     # Interactive fuzzy search (same as Ctrl+R)
sw delete [query]              # Interactively search & delete an entry
sw import [zsh|bash]           # Import your existing shell history
sw stats                       # Usage statistics
sw prune --days <n>            # Remove entries older than n days
sw daemon start|stop|status    # Manage the background daemon
sw version                     # Show version (and notify if an update exists)
```

<details>
<summary>Import existing history & clean up</summary>

```bash
sw import zsh      # from ~/.zsh_history
sw import bash     # from ~/.bash_history

sw delete          # browse all, pick one to delete
sw delete git      # pre-filter with "git"
sw prune --days 90 # drop everything older than 90 days
```

</details>

## 🧠 How it works

```text
┌──────────────┐   Unix socket (persistent)   ┌──────────────────┐
│   Zsh / Bash │◄────────────────────────────►│ shellwise daemon │
│   (shell)    │      ~1–3 ms round-trip      │   (Bun process)  │
└──────────────┘         0600, local-only     └────────┬─────────┘
                                                       │
                                              ┌────────▼─────────┐
                                              │  SQLite (WAL)    │
                                              │  history.db      │
                                              └──────────────────┘
```

- **Shell hooks** (`preexec`/`precmd`) capture each command after it runs.
- A **persistent Unix-socket connection** is opened once at shell init and reused for every keystroke — zero forks while typing.
- The daemon pre-warms **prepared SQLite statements** for instant lookups.
- **Frecency** = `frequency × recency_weight`, evaluated *at query time* so recency keeps decaying without any background job.
- The daemon **idles out after 30 min** and the shell **reconnects on demand**.

## 🗂️ Data & privacy

Everything is local to your machine:

```text
~/.local/share/shellwise/history.db    # your history (SQLite)
~/.config/shellwise/                   # config (reserved)
/tmp/shellwise-<uid>.sock              # Unix socket  (mode 0600)
/tmp/shellwise-<uid>.pid               # daemon PID   (mode 0600)
```

## ✅ Requirements

- [Bun](https://bun.sh) ≥ 1.0.0
- Zsh (full experience) or Bash (auto-save + `Ctrl+R` search)

## ⬆️ Update

`sw version` and `sw stats` tell you when a new release is out.

```bash
brew upgrade shellwise
bun install -g shellwise@latest
npm install -g shellwise@latest
```

## 🧹 Uninstall

```bash
brew uninstall shellwise      # or: bun remove -g shellwise / npm uninstall -g shellwise
```

Shell integration is removed automatically. If a stray line remains, delete it from your `~/.zshrc` / `~/.bashrc`:

```bash
# shellwise shell integration
eval "$(shellwise init zsh)"
```

Remove all stored data:

```bash
rm -rf ~/.local/share/shellwise
```

## 📄 License

[MIT](LICENSE) © [Vu Duc Tuan](https://github.com/kurovu146)
