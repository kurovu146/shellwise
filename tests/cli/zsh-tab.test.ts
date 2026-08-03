import { describe, test, expect } from "bun:test";
import { hasZsh, runZshProbe } from "./zsh-harness";

const zsh = hasZsh();

// Three suggestions and the text the user actually typed.
const setup = `
  BUFFER="git st"
  __sw_original="git st"
  __sw_suggestions=("git status" "git stash pop" "git status --short")
  __sw_sources=(history history common)
  __sw_selected=-1
  COLUMNS=60
`;

describe.skipIf(!zsh)("Tab writes the selection into the line", () => {
  test("each Tab replaces the input with the highlighted command", () => {
    const out = runZshProbe(`
      ${setup}
      __sw_next; print -r -- "1:\$BUFFER"
      __sw_next; print -r -- "2:\$BUFFER"
      __sw_next; print -r -- "3:\$BUFFER"
    `);
    expect(out.stdout).toContain("1:git status");
    expect(out.stdout).toContain("2:git stash pop");
    expect(out.stdout).toContain("3:git status --short");
  });

  test("Tab past the last item restores what the user typed", () => {
    const out = runZshProbe(`
      ${setup}
      __sw_next; __sw_next; __sw_next
      __sw_next; print -r -- "back:\$BUFFER"; print -r -- "sel:\$__sw_selected"
      __sw_next; print -r -- "again:\$BUFFER"
    `);
    expect(out.stdout).toContain("back:git st");
    expect(out.stdout).toContain("sel:-1");
    expect(out.stdout).toContain("again:git status");
  });

  test("Shift+Tab from the typed line jumps to the last item", () => {
    const out = runZshProbe(`
      ${setup}
      __sw_prev; print -r -- "last:\$BUFFER"
      __sw_prev; print -r -- "prev:\$BUFFER"
    `);
    expect(out.stdout).toContain("last:git status --short");
    expect(out.stdout).toContain("prev:git stash pop");
  });

  test("the cursor sits at the end of the filled-in command", () => {
    const out = runZshProbe(`
      ${setup}
      __sw_next
      print -r -- "cursor:\$CURSOR len:\${#BUFFER}"
    `);
    expect(out.stdout).toContain("cursor:10 len:10");
  });

  test("filling the line does not make the next keystroke re-query stale text", () => {
    const out = runZshProbe(`
      ${setup}
      __sw_next
      print -r -- "prev:\$__sw_prev_buffer"
    `);
    expect(out.stdout).toContain("prev:git status");
  });

  test("the frame follows the selection", () => {
    const out = runZshProbe(`
      ${setup}
      __sw_next; __sw_next
      print -r -- "$POSTDISPLAY"
    `);
    expect(out.stdout).toContain("› git stash pop");
    expect(out.stdout).not.toContain("› git status ");
  });

  test("Enter runs the line as shown and clears both arrays", () => {
    const out = runZshProbe(`
      ${setup}
      __sw_next
      __sw_accept_line
      print -r -- "buf:\$BUFFER"
      print -r -- "n:\${#__sw_suggestions} s:\${#__sw_sources}"
      print -r -- "post:[\$POSTDISPLAY]"
    `);
    expect(out.stdout).toContain("buf:git status");
    expect(out.stdout).toContain("n:0 s:0");
    expect(out.stdout).toContain("post:[]");
  });

  test("Esc closes the frame but keeps the command it filled in", () => {
    const out = runZshProbe(`
      ${setup}
      __sw_next
      __sw_dismiss
      print -r -- "buf:\$BUFFER"
      print -r -- "n:\${#__sw_suggestions} s:\${#__sw_sources}"
      print -r -- "post:[\$POSTDISPLAY]"
    `);
    expect(out.stdout).toContain("buf:git status");
    expect(out.stdout).toContain("n:0 s:0");
    expect(out.stdout).toContain("post:[]");
  });

  test("Right arrow on the typed line accepts the first suggestion", () => {
    const out = runZshProbe(`
      ${setup}
      CURSOR=\${#BUFFER}
      __sw_forward_char
      print -r -- "buf:\$BUFFER"
      print -r -- "n:\${#__sw_suggestions} s:\${#__sw_sources}"
    `);
    expect(out.stdout).toContain("buf:git status");
    expect(out.stdout).toContain("n:0 s:0");
  });

  test("Right arrow on a selected item accepts that item", () => {
    const out = runZshProbe(`
      ${setup}
      __sw_next; __sw_next
      CURSOR=\${#BUFFER}
      __sw_forward_char
      print -r -- "buf:\$BUFFER"
    `);
    expect(out.stdout).toContain("buf:git stash pop");
  });
});
