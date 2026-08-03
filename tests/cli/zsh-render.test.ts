import { describe, test, expect } from "bun:test";
import { generateZshScript } from "../../src/cli/init";
import { hasZsh, runZshProbe } from "./zsh-harness";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const zsh = hasZsh();

// Display width of a line, the way a terminal counts columns.
const probeWidths = `
for __l in "\${(@f)POSTDISPLAY}"; do print -r -- "W:\${(m)#__l}"; done
`;

function widths(stdout: string): number[] {
  return stdout
    .split("\n")
    .filter((l) => l.startsWith("W:"))
    .map((l) => Number(l.slice(2)))
    .filter((n) => n > 0);
}

describe.skipIf(!zsh)("__sw_render — framed dropdown", () => {
  test("the generated script is valid zsh", () => {
    const dir = mkdtempSync(join(tmpdir(), "sw-syntax-"));
    for (const remote of [false, true]) {
      const f = join(dir, `sw-${remote}.zsh`);
      writeFileSync(f, generateZshScript("shellwise", { remote }));
      const p = Bun.spawnSync(["zsh", "-n", f]);
      expect(p.stderr.toString()).toBe("");
      expect(p.exitCode).toBe(0);
    }
  });

  test("draws a rounded frame with a tag on every row", () => {
    const out = runZshProbe(`
      BUFFER="git st"
      __sw_suggestions=("git status" "git stash pop" "git status --short")
      __sw_sources=(history history common)
      __sw_selected=0
      COLUMNS=60
      __sw_render
      print -r -- "$POSTDISPLAY"
    `);
    expect(out.stderr).toBe("");
    expect(out.stdout).toContain("╭");
    expect(out.stdout).toContain("╰");
    expect(out.stdout).toContain("› git status");
    expect(out.stdout).toContain("history │");
    expect(out.stdout).toContain("common │");
  });

  test("every row is the same width, so the right border stays straight", () => {
    const out = runZshProbe(`
      BUFFER="git st"
      __sw_suggestions=("git status" "git stash pop")
      __sw_sources=(history common)
      __sw_selected=-1
      COLUMNS=60
      __sw_render
      ${probeWidths}
    `);
    expect(widths(out.stdout)).toEqual([58, 58, 58, 58]);
  });

  test("a command wider than the frame is truncated instead of breaking it", () => {
    const long = "docker run --rm -it -v /very/long/path:/app -w /app node:20 npm run build";
    const out = runZshProbe(`
      BUFFER="doc"
      __sw_suggestions=("${long}")
      __sw_sources=(history)
      __sw_selected=-1
      COLUMNS=60
      __sw_render
      print -r -- "$POSTDISPLAY"
      ${probeWidths}
    `);
    expect(out.stdout).toContain("…");
    expect(widths(out.stdout)).toEqual([58, 58, 58]);
  });

  test("truncation keeps the tail, where two similar commands differ", () => {
    const a = "docker run --rm -it -v /very/long/path:/app -w /app node:20 npm run build";
    const b = "docker run --rm -it -v /very/long/path:/app -w /app node:20 npm run test";
    const out = runZshProbe(`
      BUFFER="doc"
      __sw_suggestions=("${a}" "${b}")
      __sw_sources=(history history)
      __sw_selected=-1
      COLUMNS=60
      __sw_render
      print -r -- "$POSTDISPLAY"
      ${probeWidths}
    `);
    // The head stays readable and the ending — the only difference — survives.
    expect(out.stdout).toContain("docker run --rm -it");
    expect(out.stdout).toContain("npm run build");
    expect(out.stdout).toContain("npm run test");
    expect(widths(out.stdout)).toEqual([58, 58, 58, 58]);
  });

  test("a truncated wide-character command still fits the frame exactly", () => {
    const long = "echo 你好世界你好世界你好世界你好世界 🚀🚀🚀 done with a long tail";
    const out = runZshProbe(`
      BUFFER="ec"
      __sw_suggestions=("${long}")
      __sw_sources=(common)
      __sw_selected=-1
      COLUMNS=60
      __sw_render
      print -r -- "$POSTDISPLAY"
      ${probeWidths}
    `);
    expect(out.stdout).toContain("…");
    expect(widths(out.stdout)).toEqual([58, 58, 58]);
  });

  test("wide characters do not push the border out of line", () => {
    const out = runZshProbe(`
      BUFFER="ec"
      __sw_suggestions=("echo 你好世界 🚀 done" "echo ascii")
      __sw_sources=(history common)
      __sw_selected=0
      COLUMNS=60
      __sw_render
      ${probeWidths}
    `);
    expect(widths(out.stdout)).toEqual([58, 58, 58, 58]);
  });

  test("an older daemon sends no source, so the row renders without a tag", () => {
    const out = runZshProbe(`
      BUFFER="git"
      __sw_suggestions=("git status" "git push")
      __sw_sources=("" "")
      __sw_selected=-1
      COLUMNS=60
      __sw_render
      print -r -- "$POSTDISPLAY"
      ${probeWidths}
    `);
    expect(out.stdout).not.toContain("history");
    expect(out.stdout).not.toContain("common");
    expect(widths(out.stdout)).toEqual([58, 58, 58, 58]);
  });

  test("a narrow terminal keeps the frame but drops the tag column", () => {
    const out = runZshProbe(`
      BUFFER="git"
      __sw_suggestions=("git status" "git push origin main")
      __sw_sources=(history history)
      __sw_selected=-1
      COLUMNS=30
      __sw_render
      print -r -- "$POSTDISPLAY"
      ${probeWidths}
    `);
    expect(out.stdout).toContain("╭");
    expect(out.stdout).not.toContain("history");
    expect(widths(out.stdout)).toEqual([28, 28, 28, 28]);
  });

  test("no tty means no COLUMNS — assume 80 rather than collapsing the frame", () => {
    const out = runZshProbe(`
      BUFFER="git"
      __sw_suggestions=("git status")
      __sw_sources=(history)
      __sw_selected=-1
      # zsh sets this to 0 when it has no terminal.
      COLUMNS=0
      __sw_render
      ${probeWidths}
    `);
    expect(widths(out.stdout)).toEqual([78, 78, 78]);
  });

  test("a very narrow terminal falls back to the plain list", () => {
    const out = runZshProbe(`
      BUFFER="git"
      __sw_suggestions=("git status" "git push")
      __sw_sources=(history history)
      __sw_selected=0
      COLUMNS=20
      __sw_render
      print -r -- "$POSTDISPLAY"
    `);
    expect(out.stdout).not.toContain("╭");
    expect(out.stdout).toContain("› git status");
  });

  test("highlight ranges land on the frame, the command and the tag", () => {
    const out = runZshProbe(`
      BUFFER="git st"
      __sw_suggestions=("git status")
      __sw_sources=(history)
      __sw_selected=0
      COLUMNS=50
      __sw_render
      full="\${BUFFER}\${POSTDISPLAY}"
      for r in "\${region_highlight[@]}"; do
        s=\${r%% *}; rest=\${r#* }; e=\${rest%% *}; style=\${rest#* }
        seg="\${full[\$(( s + 1 )),\$e]}"
        print -r -- "R:\${style}:\${seg//\$'\\n'/}"
      done
    `);
    // The selected command is cyan, the tag carries the history colour.
    expect(out.stdout).toMatch(/R:fg=cyan,bold:› git status +$/m);
    expect(out.stdout).toContain("R:fg=108:history");
  });
});
