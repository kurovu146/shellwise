<div align="center">

# ⚡ shellwise

### Your shell history, but smart.

Inline auto-suggest, fuzzy search, and **frecency** ranking for your terminal —
backed by a tiny background daemon that answers in **~1–3 ms**, so suggestions keep up
with your typing instead of the other way around.

[![npm version](https://img.shields.io/npm/v/shellwise?style=flat-square&color=3fb950&label=npm)](https://www.npmjs.com/package/shellwise)
[![License](https://img.shields.io/badge/license-MIT-3b82f6?style=flat-square)](LICENSE)
[![Runtime](https://img.shields.io/badge/runtime-Bun-000000?style=flat-square&logo=bun&logoColor=white)](https://bun.sh)
[![Shell](https://img.shields.io/badge/shell-zsh%20%7C%20fish%20%7C%20bash-89e051?style=flat-square)](#-requirements)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-8b949e?style=flat-square)](#-requirements)

[Install](#-install) · [Features](#-features) · [Usage](#-usage) · [How it works](#-how-it-works)

</div>

---

<div align="center">
  <img src="assets/demo.gif" alt="shellwise demo — a framed dropdown appears under the prompt as you type, each row tagged history or common, then Ctrl+R fuzzy search" width="800">
  <br>
  <sub>Tab/⇧Tab fill the line · → accept inline · Enter run · Esc dismiss — ranked by <b>frecency</b>: how often × how recently you run it</sub>
</div>

> **Enter always runs what the line shows.** Nothing is filled in until you press
> `Tab` — then the line shows exactly the command that will run, and one more `Tab`
> past the end brings back what you typed.

Every row says where it came from, so you always know whether you are about to
re-run something of your own or reach for a command shellwise ships with:

```text
❯ docker comp
  ╭────────────────────────────────────────────────────────╮
  │ › docker compose up -d                         history │  ← yours, ranked by frecency
  │   docker compose logs -f daemon                history │
  │   docker compose down                           common │  ← built-in, no history needed
  ╰────────────────────────────────────────────────────────╯
```

## Why shellwise?

- 🧠 **Suggestions that learn you** — your real history, ranked by **frecency** (frequency × recency), so the commands you actually use float to the top and stale ones fade.
- ⚡ **Instant** — a persistent daemon answers every keystroke in ~1–3 ms over a Unix socket. In zsh nothing is ever forked while you type; fish costs one tiny `nc` per keystroke, still under 5 ms.
- ⌨️ **No `Ctrl+R` required** — see matches inline as you type. (`Ctrl+R` is still there for full-screen fuzzy search when you want it.)
- 🔒 **Private & local** — everything lives in a SQLite file on your machine, reached through a `0600` Unix socket. Nothing leaves your computer.
- 📦 **Zero config** — one install, shell integration auto-injected, done.

## 🆚 How it compares

All of these are excellent tools — the difference is *where* the suggestions live:

| | **shellwise** | [atuin](https://github.com/atuinsh/atuin) | [mcfly](https://github.com/cantino/mcfly) | [zsh-autosuggestions](https://github.com/zsh-users/zsh-autosuggestions) |
|---|:---:|:---:|:---:|:---:|
| Suggests **while you type** | ✅ dropdown | ❌ `Ctrl+R` only | ❌ `Ctrl+R` only | ✅ ghost text |
| Multiple candidates visible | ✅ | in `Ctrl+R` TUI | in `Ctrl+R` TUI | ❌ single |
| Ranking | frecency | recency + context filters | neural network | most recent prefix match |
| Fuzzy `Ctrl+R` search | ✅ | ✅ | ✅ | ❌ |
| Cross-machine sync | ❌ local-only by design | ✅ optional e2e-encrypted | ❌ | ❌ |
| Works over SSH with nothing installed remotely | ✅ `sw ssh` | ❌ install on both ends | ❌ | ❌ |
| Shells | ✅ zsh + fish (dropdown), bash (`Ctrl+R`) | ✅ | ✅ | ❌ zsh only |

**TL;DR** — if you want encrypted history sync across machines, use atuin.
If you want a ranked dropdown **under your prompt as you type** — no keybind,
no context switch — that's shellwise.

## ✨ Features

| | |
|---|---|
| **Auto-save** | Commands recorded automatically after a successful run (exit code 0). |
| **Inline auto-suggest** | A framed dropdown appears as you type — no keybind needed, every row tagged `history` or `common`. *(zsh + fish)* |
| **Fuzzy search** | `Ctrl+R` opens a full interactive search with real-time filtering. *(all three shells)* |
| **Frecency ranking** | Frequency × recency, computed at query time — recent commands rank higher and decay naturally. |
| **Common commands** | Suggests popular commands (`git`, `npm`, `docker`, …) even with empty history. |
| **Daemon mode** | Persistent background process keeps suggest latency at ~1–3 ms, idles out after 30 min. |
| **Safe & self-healing** | Reconnects automatically if the daemon restarts; preserves your command verbatim, even with `\t`/`\n`. |

## 📦 Install

> **This is a CLI tool — install it globally.**

```bash
# Homebrew (recommended — standalone binary, nothing else to install)
brew install kurovu146/tap/shellwise

# Bun (requires Bun ≥ 1.0)
bun install -g shellwise

# npm (requires Bun ≥ 1.0 as the runtime)
npm install -g shellwise
```

> The Homebrew formula (and the tarballs on [GitHub Releases](https://github.com/kurovu146/shellwise/releases))
> ship a **self-contained binary** — you do **not** need Bun, Node, or any other runtime.

Shell integration is auto-injected into your `~/.zshrc`, `~/.bashrc`, or `~/.config/fish/config.fish`.
**Open a new terminal** (or `source` your rc file) to activate.

<details>
<summary>Manual setup (if auto-inject didn't run)</summary>

```bash
# ~/.zshrc
eval "$(shellwise init zsh)"

# ~/.bashrc
eval "$(shellwise init bash)"
```

```fish
# ~/.config/fish/config.fish
shellwise init fish | source
```

</details>

## 🚀 Usage

Just start typing. After 2+ characters, suggestions from your history appear inline.

### While typing *(zsh + fish)*

| Key | Action |
|-----|--------|
| `Enter` | **Run exactly what the line shows** |
| `Tab` | Next suggestion — fills it into the line (past the last one, back to what you typed) |
| `Shift+Tab` | Previous suggestion |
| `→` Right arrow | Accept the highlighted suggestion and close the list (doesn't run it) |
| `Esc` | Close the list, keep the command on the line |

### Interactive search *(`Ctrl+R`)*

| Key | Action |
|-----|--------|
| *type* | Filter results in real time |
| `↑` / `↓` | Navigate results |
| `Enter` | Paste the selected command to your prompt |
| `Esc` | Cancel |

### Over SSH — with nothing installed on the remote host

```bash
sw ssh vps.example.com          # instead of: ssh vps.example.com
sw ssh -p 2222 user@host        # your usual ssh flags still work
```

The dropdown appears on the remote prompt, ranked by **your** history. The
remote host gets no binary, no runtime, and no edit to its `~/.zshrc`: the
integration is pure zsh, shipped over as a throwaway `ZDOTDIR`, talking to a
socket reverse-forwarded back to your local daemon. Your history file never
leaves your machine.

```text
remote zsh ──▶ /tmp/shellwise-ssh-*.sock ══ ssh -R ══▶ local proxy ──▶ daemon ──▶ history.db
```

Because that socket is reachable by anyone with root on the remote box, the
proxy is **read-only**: it answers `SUGGEST`, and silently drops `ADD` and
`STOP`. So a compromised host can neither plant a command in your history nor
stop your daemon. Pass `--save-history` if you do want remote commands recorded.

Every keystroke's answer crosses the network twice, so on a distant host the
dropdown lands a round trip late — around 250 ms for a VPS on another continent.
**Your typing is not held up by it:** the request is sent and the line editor
carries on, and the frame is drawn whenever the reply arrives.

Needs zsh on the remote host (`Ctrl+R` search stays the host's own — the TUI
needs the binary). No zsh over there, or forwarding blocked? You get a normal
shell instead of a broken one.

## 🔧 Commands

Both `shellwise` and the short alias `sw` work:

```bash
sw ssh [ssh options] <host>    # SSH with suggestions on the remote host
sw search [--query <text>]     # Interactive fuzzy search (same as Ctrl+R)
sw delete [query]              # Interactively search & delete an entry
sw import [zsh|bash|fish]      # Import your existing shell history
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
sw import fish     # from ~/.local/share/fish/fish_history

sw delete          # browse all, pick one to delete
sw delete git      # pre-filter with "git"
sw prune --days 90 # drop everything older than 90 days
```

</details>

## 🧠 How it works

```text
┌────────────────────┐   Unix socket · ~1–3 ms   ┌───────────────────┐
│ Zsh · Bash · Fish  │ ◄═══════════════════════► │ shellwise daemon  │
└────────────────────┘                           └─────────┬─────────┘
                                                           │
                                                 ┌─────────▼─────────┐
                                                 │  SQLite (WAL)     │
                                                 │  history.db       │
                                                 └───────────────────┘
```

- **Shell hooks** (`preexec`/`precmd`, `fish_postexec`) capture each command after it runs.
- A **persistent Unix-socket connection** is opened once at shell init and reused for every keystroke — zero forks while typing. *(zsh; fish has no socket builtin, so it spends one `nc` per keystroke — about 4.5 ms.)*
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
/tmp/shellwise-ssh-<uid>-<rand>.sock   # per-session `sw ssh` proxy (mode 0600)
```

## ✅ Requirements

- macOS or Linux
- Zsh or fish (full experience) — or Bash (auto-save + `Ctrl+R` search)
- fish needs `nc` or `socat` for the dropdown, since fish has no socket builtin.
  macOS ships `nc`; on Linux install `netcat-openbsd`. Without either, fish keeps
  auto-save and `Ctrl+R`, just no dropdown.
- [Bun](https://bun.sh) ≥ 1.0.0 — **only when installing via `bun`/`npm`**. The Homebrew and GitHub-release binaries are standalone.

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

Shell integration is removed automatically. If a stray line remains, delete it from
your `~/.zshrc`, `~/.bashrc`, or `~/.config/fish/config.fish`:

```bash
# shellwise shell integration
eval "$(shellwise init zsh)"      # zsh / bash
shellwise init fish | source      # fish
```

Remove all stored data:

```bash
rm -rf ~/.local/share/shellwise
```

## 📄 License

[MIT](LICENSE) © [Vu Duc Tuan](https://github.com/kurovu146)
