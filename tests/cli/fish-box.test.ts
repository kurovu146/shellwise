import { describe, test, expect } from "bun:test";
import { generateFishScript } from "../../src/cli/init/fish";
import { hasFish, runFishProbe, stripAnsi } from "./fish-harness";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const fish = hasFish();

// Print each frame line with its display width so tests can assert alignment.
const withWidths = `
for __l in (__sw_box_lines $__test_cols)
    printf '%s|W:%s\\n' $__l (string length --visible -- $__l)
end
`;

function widths(stdout: string): number[] {
  return stripAnsi(stdout)
    .split("\n")
    .filter((l) => l.includes("|W:"))
    .map((l) => Number(l.slice(l.indexOf("|W:") + 3)));
}

describe.skipIf(!fish)("__sw_box_lines", () => {
  test("the generated script is valid fish", () => {
    const dir = mkdtempSync(join(tmpdir(), "sw-fish-syntax-"));
    const f = join(dir, "sw.fish");
    writeFileSync(f, generateFishScript("shellwise"));
    const p = Bun.spawnSync(["fish", "-n", f]);
    expect(p.stderr.toString()).toBe("");
    expect(p.exitCode).toBe(0);
  });

  test("draws a rounded frame with a tag on every row", () => {
    const out = runFishProbe(`
      set -g __sw_suggestions 'git status' 'git stash pop' 'git status --short'
      set -g __sw_sources history history common
      set -g __sw_selected 0
      set -g __test_cols 60
      ${withWidths}
    `);
    const clean = stripAnsi(out.stdout);
    expect(out.stderr).toBe("");
    expect(clean).toContain("╭");
    expect(clean).toContain("╰");
    expect(clean).toContain("› git status");
    expect(clean).toContain("history │");
    expect(clean).toContain("common │");
    expect(widths(out.stdout)).toEqual([58, 58, 58, 58, 58]);
  });

  test("truncation keeps the tail, where two similar commands differ", () => {
    const out = runFishProbe(`
      set -g __sw_suggestions 'docker run --rm -it -v /very/long/path:/app -w /app npm run build' 'docker run --rm -it -v /very/long/path:/app -w /app npm run test'
      set -g __sw_sources history history
      set -g __sw_selected -1
      set -g __test_cols 60
      ${withWidths}
    `);
    const clean = stripAnsi(out.stdout);
    expect(clean).toContain("…");
    expect(clean).toContain("npm run build");
    expect(clean).toContain("npm run test");
    expect(widths(out.stdout)).toEqual([58, 58, 58, 58]);
  });

  test("wide characters do not push the border out of line", () => {
    const out = runFishProbe(`
      set -g __sw_suggestions 'echo 你好世界 🚀 done' 'echo ascii'
      set -g __sw_sources history common
      set -g __sw_selected 0
      set -g __test_cols 60
      ${withWidths}
    `);
    expect(widths(out.stdout)).toEqual([58, 58, 58, 58]);
  });

  test("a truncated wide-character command still fits exactly", () => {
    const out = runFishProbe(`
      set -g __sw_suggestions 'echo 你好世界你好世界你好世界你好世界 🚀🚀🚀 tail here'
      set -g __sw_sources common
      set -g __sw_selected -1
      set -g __test_cols 60
      ${withWidths}
    `);
    expect(stripAnsi(out.stdout)).toContain("…");
    expect(widths(out.stdout)).toEqual([58, 58, 58]);
  });

  test("an older daemon sends no source, so the row renders without a tag", () => {
    const out = runFishProbe(`
      set -g __sw_suggestions 'git status' 'git push'
      set -g __sw_sources '' ''
      set -g __sw_selected -1
      set -g __test_cols 60
      ${withWidths}
    `);
    const clean = stripAnsi(out.stdout);
    expect(clean).not.toContain("history");
    expect(clean).not.toContain("common");
    expect(widths(out.stdout)).toEqual([58, 58, 58, 58]);
  });

  test("a narrow terminal keeps the frame but drops the tag column", () => {
    const out = runFishProbe(`
      set -g __sw_suggestions 'git status' 'git push origin main'
      set -g __sw_sources history history
      set -g __sw_selected -1
      set -g __test_cols 30
      ${withWidths}
    `);
    const clean = stripAnsi(out.stdout);
    expect(clean).toContain("╭");
    expect(clean).not.toContain("history");
    expect(widths(out.stdout)).toEqual([28, 28, 28, 28]);
  });

  test("a very narrow terminal falls back to the plain list", () => {
    const out = runFishProbe(`
      set -g __sw_suggestions 'git status' 'git push'
      set -g __sw_sources history history
      set -g __sw_selected 0
      set -g __test_cols 20
      ${withWidths}
    `);
    const clean = stripAnsi(out.stdout);
    expect(clean).not.toContain("╭");
    expect(clean).toContain("› git status");
  });

  test("no COLUMNS at all means assume 80, not a collapsed frame", () => {
    const out = runFishProbe(`
      set -g __sw_suggestions 'git status'
      set -g __sw_sources history
      set -g __sw_selected -1
      set -g __test_cols 0
      ${withWidths}
    `);
    expect(widths(out.stdout)).toEqual([78, 78, 78]);
  });

  test("an empty list draws nothing at all", () => {
    const out = runFishProbe(`
      set -g __sw_suggestions
      set -g __sw_sources
      set -g __sw_selected -1
      set -g __test_cols 60
      ${withWidths}
    `);
    expect(stripAnsi(out.stdout).trim()).toBe("");
  });
});
