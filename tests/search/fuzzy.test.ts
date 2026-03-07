import { describe, test, expect } from "bun:test";
import { fuzzyMatch, fuzzyFilter } from "../../src/search/fuzzy";

describe("fuzzyMatch", () => {
  test("exact match returns high score", () => {
    const result = fuzzyMatch("git status", "git status");
    expect(result).not.toBeNull();
    expect(result!.score).toBeGreaterThan(0.7);
  });

  test("prefix match", () => {
    const result = fuzzyMatch("git", "git status");
    expect(result).not.toBeNull();
    expect(result!.score).toBeGreaterThan(0.5);
  });

  test("fuzzy match with gaps", () => {
    const result = fuzzyMatch("gts", "git status");
    expect(result).not.toBeNull();
    expect(result!.positions).toContain(0); // g
    expect(result!.positions).toContain(4); // s (in "status")
  });

  test("no match returns null", () => {
    const result = fuzzyMatch("xyz", "git status");
    expect(result).toBeNull();
  });

  test("empty query matches everything", () => {
    const result = fuzzyMatch("", "git status");
    expect(result).not.toBeNull();
    expect(result!.score).toBe(1);
  });

  test("case insensitive matching", () => {
    const result = fuzzyMatch("GIT", "git status");
    expect(result).not.toBeNull();
  });

  test("word boundary bonus", () => {
    const boundary = fuzzyMatch("gs", "git status");
    const middle = fuzzyMatch("it", "git status");
    expect(boundary).not.toBeNull();
    expect(middle).not.toBeNull();
    // "gs" matches at word boundaries (g=start, s=after space)
    // "it" matches in the middle
    expect(boundary!.score).toBeGreaterThan(middle!.score);
  });
});

describe("fuzzyFilter", () => {
  test("filters and sorts by score", () => {
    const items = [
      "docker compose up -d",
      "git status",
      "git stash pop",
      "bun test",
    ];
    const results = fuzzyFilter("gts", items);
    expect(results.length).toBe(2); // git status, git stash
    expect(results[0].text).toContain("git");
  });

  test("returns empty for no matches", () => {
    const results = fuzzyFilter("zzz", ["git status", "bun test"]);
    expect(results).toHaveLength(0);
  });
});
