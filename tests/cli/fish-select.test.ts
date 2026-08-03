import { describe, test, expect } from "bun:test";
import { hasFish, runFishProbe } from "./fish-harness";

const fish = hasFish();

const setup = `
  set -g __sw_original "git st"
  set -g __sw_suggestions 'git status' 'git stash pop' 'git status --short'
  set -g __sw_sources history history common
  set -g __sw_selected -1
`;

describe.skipIf(!fish)("selection cycle", () => {
  test("each next step moves to the following command", () => {
    const out = runFishProbe(`
      ${setup}
      __sw_cycle next; echo "1:"(__sw_selection_text)
      __sw_cycle next; echo "2:"(__sw_selection_text)
      __sw_cycle next; echo "3:"(__sw_selection_text)
    `);
    expect(out.stdout).toContain("1:git status");
    expect(out.stdout).toContain("2:git stash pop");
    expect(out.stdout).toContain("3:git status --short");
  });

  test("going past the last item restores what the user typed", () => {
    const out = runFishProbe(`
      ${setup}
      __sw_cycle next; __sw_cycle next; __sw_cycle next
      __sw_cycle next; echo "back:"(__sw_selection_text); echo "sel:$__sw_selected"
      __sw_cycle next; echo "again:"(__sw_selection_text)
    `);
    expect(out.stdout).toContain("back:git st");
    expect(out.stdout).toContain("sel:-1");
    expect(out.stdout).toContain("again:git status");
  });

  test("stepping backwards from the typed line lands on the last item", () => {
    const out = runFishProbe(`
      ${setup}
      __sw_cycle prev; echo "last:"(__sw_selection_text)
      __sw_cycle prev; echo "prev:"(__sw_selection_text)
    `);
    expect(out.stdout).toContain("last:git status --short");
    expect(out.stdout).toContain("prev:git stash pop");
  });

  test("an empty list leaves the selection alone", () => {
    const out = runFishProbe(`
      set -g __sw_suggestions
      set -g __sw_sources
      set -g __sw_original "git st"
      set -g __sw_selected -1
      __sw_cycle next
      echo "sel:$__sw_selected"
      echo "text:"(__sw_selection_text)
    `);
    expect(out.stdout).toContain("sel:-1");
    expect(out.stdout).toContain("text:git st");
  });

  test("clearing resets both arrays and the drawn flag", () => {
    const out = runFishProbe(`
      ${setup}
      set -g __sw_drawn 1
      __sw_reset
      echo "n:"(count $__sw_suggestions)" s:"(count $__sw_sources)" drawn:$__sw_drawn"
    `);
    expect(out.stdout).toContain("n:0 s:0 drawn:0");
  });
});
