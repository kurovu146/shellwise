<div align="center">

# ⚡ shellwise

### Your shell history, but smart.

Inline auto-suggest, fuzzy search, and **frecency** ranking for your terminal —
backed by a tiny background daemon that answers in **~1–3 ms**, so suggestions keep up
with your typing instead of the other way around.

[![npm version](https://img.shields.io/npm/v/shellwise?style=flat-square&color=3fb950&label=npm)](https://www.npmjs.com/package/shellwise)
[![Tests](https://img.shields.io/github/actions/workflow/status/kurovu146/shellwise/test.yml?branch=main&style=flat-square&label=tests)](https://github.com/kurovu146/shellwise/actions/workflows/test.yml)
[![License](https://img.shields.io/badge/license-MIT-3b82f6?style=flat-square)](LICENSE)
[![Runtime](https://img.shields.io/badge/runtime-Bun-000000?style=flat-square&logo=bun&logoColor=white)](https://bun.sh)
[![Shell](https://img.shields.io/badge/shell-zsh%20%7C%20fish%20%7C%20bash%20%7C%20powershell-89e051?style=flat-square)](#-requirements)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-8b949e?style=flat-square)](#-requirements)

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
- 🔒 **Private & local** — everything lives in a SQLite file on your machine, reached through a `0600` Unix socket (on Windows the socket is protected by your own `%TEMP%` folder's permissions, not by a file mode). Your history never leaves your computer; the only network request is a daily version check against the npm registry, which `SHELLWISE_NO_UPDATE_CHECK=1` turns off (see Update).
- 📦 **Zero config** — one install, shell integration auto-injected, done. (On Windows: one line in `$PROFILE`, see [below](#-windows--powershell).)

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
| Shells | ✅ zsh + fish (dropdown), PowerShell 7.2+ (list), bash (`Ctrl+R`) | ✅ | ✅ | ❌ zsh only |

**TL;DR** — if you want encrypted history sync across machines, use atuin.
If you want a ranked dropdown **under your prompt as you type** — no keybind,
no context switch — that's shellwise.

## ✨ Features

| | |
|---|---|
| **Auto-save** | Commands recorded automatically after a successful run (exit code 0). |
| **Inline auto-suggest** | A framed dropdown appears as you type — no keybind needed, every row tagged `history` or `common`. *(zsh + fish; PowerShell 7.2+ shows a list, see [Windows](#-windows--powershell))* |
| **Fuzzy search** | `Ctrl+R` opens a full interactive search with real-time filtering. *(every supported shell)* |
| **Frecency ranking** | Frequency × recency, computed at query time — recent commands rank higher and decay naturally. |
| **Common commands** | Suggests popular commands (`git`, `npm`, `docker`, …) even with empty history. |
| **Daemon mode** | Persistent background process keeps suggest latency at ~1–3 ms, idles out after 30 min. |
| **Safe & self-healing** | Reconnects automatically if the daemon restarts. |

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
**Open a new terminal** (or `source` your rc file) to activate. On Windows, see [below](#-windows--powershell).

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

## 🪟 Windows / PowerShell

PowerShell is tested on Windows only; Git Bash and PowerShell on macOS / Linux are untested.
Install with `bun install -g shellwise` or `npm install -g shellwise` (both need
[Bun](https://bun.sh) as the runtime), or download `shellwise-windows-x64.zip` from
[GitHub Releases](https://github.com/kurovu146/shellwise/releases), unzip it and put
`shellwise.exe` on your `PATH` — a standalone binary, no Bun needed. It is
**unsigned**, so SmartScreen may warn. The zip has no `sw` alias; to get one, add
`Set-Alias sw shellwise` to your `$PROFILE`.

Then add this line to your `$PROFILE` and open a new shell:

```powershell
shellwise init powershell | Out-String | Invoke-Expression
```

PowerShell 7 and Windows PowerShell each have their own `$PROFILE`; add the line to each one you
use. If the file does not exist yet, create it first:

```powershell
if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force }; notepad $PROFILE
```

Put it **after** other prompt tools (oh-my-posh, starship): a tool that replaces `prompt` after
this line removes the hook that saves your commands. Put it after your own `Tab` / `Ctrl+R`
bindings too if shellwise should have those keys — a binding or PSReadLine option set after this
line wins. `$PROFILE` only loads when scripts are allowed:
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

`npm install -g shellwise` adds the line for you — to the `$PROFILE` of PowerShell 7 and of Windows
PowerShell, wherever the execution policy is RemoteSigned, Unrestricted or Bypass (an existing
profile is first copied to `<profile>.shellwise-backup`). npm hides the hook's messages, so look
into `$PROFILE` afterwards and add the line yourself if it is not there. `bun install -g` blocks
postinstall scripts by default, so with Bun add the line yourself.

| Shell | Auto-save | Suggestions while typing | `Ctrl+R` |
|---|:---:|---|:---:|
| zsh, fish | ✅ | ✅ dropdown | ✅ |
| PowerShell 7.2+ with PSReadLine 2.2.2+ | ✅ | ✅ PSReadLine list, `Tab` / `Shift+Tab` | ✅ |
| bash, Windows PowerShell 5.1 | ✅ | ❌ | ✅ |

**What the init script changes in PSReadLine** (the first three only in PowerShell 7.2+ with PSReadLine 2.2.2+; `Ctrl+R` in every version):

- sets `PredictionViewStyle` to `ListView`, on every load;
- adds `Plugin` to the prediction source (`None` becomes `Plugin`, `History` becomes `HistoryAndPlugin`);
- binds `Tab` / `Shift+Tab` to the next / previous entry of PSReadLine's list when a list is showing — PSReadLine's own `[History]` entries included, not only shellwise's. With no list on screen the key does what it did before, so completion keeps working there. With `TabCompleteNext` (PSReadLine's default), a `Tab` right after a completion goes on to the next completion even when a list is showing, and into the list once completing changes nothing; with `MenuComplete` the list always comes first;
- binds `Ctrl+R` to the fuzzy search.

A `Tab` or `Shift+Tab` you bound to your own script block is not rebound: the list still shows
and your key keeps its job. `Get-PSReadLineKeyHandler` shows the bindings as `ShellwiseNext`,
`ShellwisePrevious` and `ShellwiseSearch`. These are labels, not PSReadLine functions
(`-Function ShellwiseNext` is rejected); to walk the list with other keys, bind PSReadLine's own
`NextSuggestion` / `PreviousSuggestion`. While a list is showing, `Ctrl+Space` (PSReadLine's
`MenuComplete`) is the key for completion. In a console smaller than 50 columns × 5 rows, or with
redirected output, the list view and `Tab` / `Shift+Tab` are left as they were (`Ctrl+R` is still
bound).

To undo it, remove the line from `$PROFILE` and open a new shell. The background daemon keeps
running until it idles out after 30 minutes, or until `shellwise daemon stop` from a shell
without the line. To keep shellwise but restore PSReadLine's defaults, set them after the init line:

```powershell
# PowerShell 7.2+ — PSReadLine's defaults on Windows
Set-PSReadLineOption -PredictionViewStyle InlineView
Set-PSReadLineKeyHandler -Chord Tab -Function TabCompleteNext
Set-PSReadLineKeyHandler -Chord Shift+Tab -Function TabCompletePrevious
Set-PSReadLineKeyHandler -Chord Ctrl+r -Function ReverseSearchHistory
```

The suggestion helper is a small C# plugin, compiled the first time it is needed and cached in the
data directory (compiled again only when a shellwise update changes it or PowerShell moves to a
new minor version); that one start is noticeably slower (roughly half a second). The line adds
roughly 0.2 s to an interactive `pwsh` start and about 0.25 s to `pwsh -Command`, which would not
load PSReadLine otherwise (measured on one machine).

Not supported on Windows yet: `sw ssh` (it prints `shellwise ssh is not supported on Windows yet.`
and exits 1), cmd.exe, and an arm64 binary. Multi-line commands are
neither saved live nor imported. The built-in `common` suggestions include POSIX commands
(`chmod +x`, `grep -r`) and are offered in PowerShell too.

## 🚀 Usage

Just start typing. After 2+ characters, suggestions from your history appear inline.

### While typing *(zsh + fish; PowerShell 7.2+ has `Tab` / `Shift+Tab` and a list)*

| Key | Action |
|-----|--------|
| `Enter` | **Run exactly what the line shows** |
| `Tab` | Next suggestion — fills it into the line (past the last one, back to what you typed) |
| `Shift+Tab` | Previous suggestion |
| `→` Right arrow | Accept the highlighted suggestion and close the list (doesn't run it) |
| `Esc` | Close the list, keep the command on the line |

In PowerShell the list is PSReadLine's own: `Tab`, `Shift+Tab` and `Enter` work as above, but
`Esc` goes back to what you typed (a second `Esc` clears the line) and `→` accepts nothing — the
selected command is already on the line.

### Interactive search *(`Ctrl+R`)*

| Key | Action |
|-----|--------|
| *type* | Filter results in real time |
| `↑` / `↓` | Navigate results |
| `Enter` | Paste the selected command to your prompt |
| `Esc` | Cancel |

### Over SSH — with nothing installed on the remote host *(from macOS / Linux)*

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

Both `shellwise` and the short alias `sw` work (the Windows zip has no `sw`, see [Windows](#-windows--powershell)):

```bash
sw ssh [ssh options] <host>    # SSH with suggestions on the remote host
sw search [--query <text>]     # Interactive fuzzy search (same as Ctrl+R)
sw delete [query]              # Interactively search & delete an entry
sw import [zsh|bash|fish|powershell]  # Import your existing shell history
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
sw import powershell  # from PSReadLine's ConsoleHost_history.txt (single-line entries)

sw delete          # browse all, pick one to delete
sw delete git      # pre-filter with "git"
sw prune --days 90 # drop everything older than 90 days
```

</details>

## 🧠 How it works

```text
┌────────────────────┐   Unix socket · ~1–3 ms   ┌───────────────────┐
│ zsh·fish·bash·pwsh │ ◄═══════════════════════► │ shellwise daemon  │
└────────────────────┘                           └─────────┬─────────┘
                                                           │
                                                 ┌─────────▼─────────┐
                                                 │  SQLite (WAL)     │
                                                 │  history.db       │
                                                 └───────────────────┘
```

- **Shell hooks** (`preexec`/`precmd`, `fish_postexec`; a wrapped `prompt` in PowerShell) capture each command after it runs.
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

On Windows the same files live under `%USERPROFILE%\.local\share\shellwise` and
`%USERPROFILE%\.config\shellwise` (`XDG_DATA_HOME` / `XDG_CONFIG_HOME` are honoured), and the
daemon's per-user socket file is in `%TEMP%`. It is protected by the permissions of your own
`%TEMP%` folder, not by a file mode.

In PowerShell, a line that PSReadLine's built-in rule keeps out of its own history file is not
recorded either. That rule is a word match (`password`, `asplaintext`, `token`, `apikey`, `secret`;
the PSReadLine 2.0 that ships with Windows PowerShell 5.1 matches any `key`), not secret detection:
`gh auth token` is skipped, `$env:OPENAI_API_KEY = '…'` is not.

## ✅ Requirements

- macOS, Linux or Windows (x64)
- Zsh or fish (full experience), PowerShell 7.2+ with PSReadLine 2.2.2+ (suggestion list) — or Bash / Windows PowerShell 5.1 (auto-save + `Ctrl+R` search)
- fish needs `nc` or `socat` for the dropdown, since fish has no socket builtin.
  macOS ships `nc`; on Linux install `netcat-openbsd`. Without either, fish keeps
  auto-save and `Ctrl+R`, just no dropdown.
- Known issue: with fish inside tmux on Linux (seen with fish 4.2 on Ubuntu) the
  dropdown frame does not show; `Tab` still fills in the suggestion.
- The test suite runs on macOS, Linux and Windows on every push.
- [Bun](https://bun.sh) ≥ 1.0.0 (on Windows a current Bun release — CI runs the latest — and, [as Bun requires](https://bun.sh/docs/installation), Windows 10 version 1809 or later) — **only when installing via `bun`/`npm`**. The Homebrew and GitHub-release binaries (including the Windows zip) are standalone.

## ⬆️ Update

`sw version` and `sw stats` tell you when a new release is out (`SHELLWISE_NO_UPDATE_CHECK=1`
turns that daily check off; set it before the shell integration loads and run `sw daemon stop`
once, because a daemon that is already running keeps its old environment).

```bash
brew upgrade shellwise
bun install -g shellwise@latest
npm install -g shellwise@latest
```

On Windows with the zip: the running daemon keeps `shellwise.exe` locked, and a PowerShell 7.2+
that has shellwise loaded starts it again with the next command you run. Stop it and swap the file in one line,
from the folder that holds the new `shellwise.exe`:

```powershell
shellwise daemon stop; Copy-Item .\shellwise.exe (Get-Command shellwise).Source -Force
```

## 🧹 Uninstall

```bash
brew uninstall shellwise      # or: bun remove -g shellwise / npm uninstall -g shellwise
```

Shell integration is removed automatically (npm 7 and later and Bun do not run uninstall scripts,
so there it stays). If a line remains, delete it from
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

On Windows nothing removes the integration for you: npm (7 and later) does not run uninstall
scripts, and Bun does not run the hook either. Delete the `# shellwise shell integration` line and
the `shellwise init powershell` line from `$PROFILE` — PowerShell 7 and Windows PowerShell each
have their own — then close every PowerShell window, open a new one and run:

```powershell
shellwise daemon stop           # it keeps history.db and shellwise.exe open
npm uninstall -g shellwise      # or: bun remove -g shellwise / delete shellwise.exe
Remove-Item -Recurse -Force "$env:USERPROFILE\.local\share\shellwise"   # all stored data
```

If npm added the line, it left a copy of your old profile next to it as `<profile>.shellwise-backup`.

## 📄 License

[MIT](LICENSE) © [Vu Duc Tuan](https://github.com/kurovu146)
