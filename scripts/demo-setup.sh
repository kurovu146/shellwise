#!/bin/bash
# Build an isolated environment for recording assets/demo.gif.
#
# Isolation matters for two reasons: the recording must never show the real
# command history, and the suggestions have to be reproducible. HOME and
# XDG_DATA_HOME are faked; the daemon socket is NOT (it is keyed by uid), so
# demo-record.sh stops the real daemon before recording.
set -euo pipefail

DEMO="${1:-/tmp/shellwise-demo}"
# Resolved before any cd below, or the relative path breaks.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

rm -rf "$DEMO"
mkdir -p "$DEMO/home" "$DEMO/data" "$DEMO/repo"

export HOME="$DEMO/home"
export XDG_DATA_HOME="$DEMO/data"

# A small git repo so `git status` prints something worth looking at.
cd "$DEMO/repo"
git init -q -b main
git config user.email demo@example.com
git config user.name "Demo"
printf '# shellwise\n\nYour shell history, but smart.\n' > README.md
mkdir -p src
printf 'export const version = "0.4.0";\n' > src/index.ts
git add -A
git commit -qm "initial commit"
printf 'export const version = "0.4.1";\n' > src/index.ts
printf 'notes\n' > TODO.md

# Seed history. Repeats raise frequency, which is what frecency ranks on —
# importing would not work here because import dedupes by hash.
#
# This writes straight to the database instead of running `shellwise add`:
# that command prefers the daemon, and the daemon socket is keyed by uid, not
# by XDG_DATA_HOME. Going through it would seed the *real* history instead of
# the demo one — which is exactly what happened the first time.
# Arguments go through the environment: `bun -e` leaves no script path in
# process.argv, so positional indexes are off by one compared with a normal run.
seed() {
  SEED_TIMES="$1" SEED_CMD="$2" bun -e '
    const { insertCommand } = await import(process.env.ROOT + "/src/db/queries.ts");
    for (let i = 0; i < Number(process.env.SEED_TIMES); i++) {
      insertCommand({
        command: process.env.SEED_CMD,
        cwd: process.env.DEMO_REPO,
        exit_code: 0,
        shell: "zsh",
      });
    }
  '
}
export ROOT DEMO_REPO="$DEMO/repo"

seed 9 "git status"
seed 6 "git stash pop"
seed 4 "git switch -c feature/frecency-ranking"
seed 3 "git commit -am 'wire up the daemon'"
seed 7 "docker compose up -d"
seed 5 "docker compose logs -f daemon"
seed 4 "npm run build -- --watch"
seed 3 "npm test -- --coverage"
seed 5 "cd ~/Dev/shellwise"
seed 2 "bun run src/index.ts daemon status"

cat > "$DEMO/home/.zshrc" <<'ZSHRC'
autoload -Uz colors && colors
PROMPT='%F{81}❯%f '
RPROMPT=''
eval "$(shellwise init zsh)"
ZSHRC

echo "$DEMO"
