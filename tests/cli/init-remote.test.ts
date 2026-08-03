import { describe, test, expect } from "bun:test";
import { generateZshScript } from "../../src/cli/init";

describe("generateZshScript — local mode", () => {
  const script = generateZshScript("shellwise", { remote: false });

  test("starts the daemon when the socket is missing", () => {
    expect(script).toContain("daemon start");
  });

  test("binds Ctrl+R to the interactive search widget", () => {
    expect(script).toContain("bindkey '^R' __sw_search_widget");
  });

  test("uses the uid-scoped socket in /tmp", () => {
    expect(script).toContain('__sw_sock="/tmp/shellwise-${UID}.sock"');
  });
});

describe("generateZshScript — remote mode", () => {
  const script = generateZshScript("shellwise", { remote: true });

  test("never invokes the shellwise binary", () => {
    // The remote host has no shellwise installed — any `command shellwise ...`
    // would print a "command not found" into the user's prompt.
    expect(script).not.toContain("command shellwise");
    expect(script).not.toContain("daemon start");
  });

  test("reads the socket path from SHELLWISE_SOCKET", () => {
    expect(script).toContain("SHELLWISE_SOCKET");
  });

  test("leaves Ctrl+R to zsh's own history search", () => {
    // The TUI needs the binary; hijacking Ctrl+R would break the key entirely.
    expect(script).not.toContain("bindkey '^R'");
    expect(script).not.toContain("__sw_search_widget");
  });

  test("still records commands over the socket", () => {
    expect(script).toContain("__sw_query ADD");
  });

  test("still renders the inline dropdown", () => {
    // The request goes out through the async channel, not the blocking query.
    expect(script).toContain("__sw_sconnect");
    expect(script).toContain("SUGGEST");
    expect(script).toContain("bindkey '\\t' __sw_next");
  });
});
