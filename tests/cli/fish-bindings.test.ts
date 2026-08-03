import { describe, test, expect } from "bun:test";
import { generateFishScript } from "../../src/cli/init/fish";
import { hasFish } from "./fish-harness";

const script = generateFishScript("shellwise");
const fish = hasFish();

describe("generated fish script", () => {
  test("binds every key the docs promise", () => {
    expect(script).toContain("bind \\t __sw_accept");
    expect(script).toContain("bind \\e\\[Z");
    expect(script).toContain("bind \\e\\[C __sw_forward");
    expect(script).toContain("bind \\cr __sw_search");
    expect(script).toContain("bind \\r __sw_execute");
    expect(script).toContain("bind \\x7f __sw_backspace");
  });

  test("records commands through the session id and duration fish gives us", () => {
    expect(script).toContain("--on-event fish_postexec");
    expect(script).toContain("$CMD_DURATION");
    expect(script).toContain("$SW_SESSION_ID");
    expect(script).toContain("ADD");
  });

  test("Ctrl+R runs the binary, not the socket", () => {
    expect(script).toContain("shellwise search");
  });

  test("starts the daemon when the socket is missing", () => {
    expect(script).toContain("daemon start");
  });

  test("keeps every side effect behind the interactive guard", () => {
    // Sourcing this file in a script must not rebind keys or spawn a daemon.
    const guard = script.indexOf("status is-interactive");
    expect(guard).toBeGreaterThan(-1);
    expect(script.indexOf("bind \\t __sw_accept")).toBeGreaterThan(guard);
  });
});

describe.skipIf(!fish)("generated fish script — syntax", () => {
  test("parses under fish -n", () => {
    const p = Bun.spawnSync(["fish", "-n", "/dev/stdin"], { stdin: Buffer.from(script) });
    expect(p.stderr.toString()).toBe("");
    expect(p.exitCode).toBe(0);
  });
});
