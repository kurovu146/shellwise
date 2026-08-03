import { describe, test, expect } from "bun:test";
import { parseRequest, serializeRequest, formatSuggestResponse } from "../../src/daemon/protocol";

describe("SUGGEST request", () => {
  test("a v1 client sends exactly what it always sent", () => {
    expect(serializeRequest({ type: "SUGGEST", query: "git st", limit: 5, tagged: false })).toBe(
      "SUGGEST\tgit st\t5\n"
    );
  });

  test("a v2 client asks for tagged lines", () => {
    expect(serializeRequest({ type: "SUGGEST", query: "git st", limit: 5, tagged: true })).toBe(
      "SUGGEST\tgit st\t5\tv2\n"
    );
  });

  test("a request from an old shell parses as untagged", () => {
    expect(parseRequest("SUGGEST\tgit st\t5")).toEqual({
      type: "SUGGEST",
      query: "git st",
      limit: 5,
      tagged: false,
    });
  });

  test("a v2 request parses as tagged", () => {
    expect(parseRequest("SUGGEST\tgit st\t5\tv2")).toEqual({
      type: "SUGGEST",
      query: "git st",
      limit: 5,
      tagged: true,
    });
  });

  test("an unknown protocol marker is not mistaken for v2", () => {
    expect(parseRequest("SUGGEST\tgit st\t5\tv9")).toMatchObject({ tagged: false });
  });
});

describe("formatSuggestResponse", () => {
  const results = [
    { command: "git status", source: "history" as const },
    { command: "git stash pop", source: "history" as const },
    { command: "git status --short", source: "common" as const },
  ];

  test("an old shell still gets bare commands", () => {
    expect(formatSuggestResponse(results, false)).toBe(
      "git status\ngit stash pop\ngit status --short\n\n"
    );
  });

  test("a v2 shell gets the source of every line", () => {
    expect(formatSuggestResponse(results, true)).toBe(
      "history\tgit status\nhistory\tgit stash pop\ncommon\tgit status --short\n\n"
    );
  });

  test("no results terminates the reply without a body", () => {
    expect(formatSuggestResponse([], true)).toBe("\n");
    expect(formatSuggestResponse([], false)).toBe("\n");
  });

  test("the source goes first so a tab inside a command survives the round trip", () => {
    const line = formatSuggestResponse([{ command: "echo a\tb", source: "history" }], true);
    const body = line.slice(0, line.indexOf("\n"));
    expect(body.slice(0, body.indexOf("\t"))).toBe("history");
    expect(body.slice(body.indexOf("\t") + 1)).toBe("echo a\tb");
  });
});
