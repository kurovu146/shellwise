import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ENTRY = join(import.meta.dir, "..", "..", "src", "index.ts");

describe("processes opening the database at the same moment", () => {
  // A shell start does this: `add` for the last command and the daemon open
  // the database together. Before the busy timeout was set first, the losers
  // failed with "database is locked" and their command was gone.
  test("every one of them stores its command", async () => {
    const N = 10;
    for (let round = 0; round < 3; round++) {
      const data = mkdtempSync(join(tmpdir(), "sw-open-"));
      const env = { ...process.env, XDG_DATA_HOME: data, SHELLWISE_DAEMON_SOCKET: join(data, "none.sock") };
      // Create the database, then leave it with no connection open.
      Bun.spawnSync([process.execPath, ENTRY, "add", "seed command"], { env });

      const adds = Array.from({ length: N }, (_, i) =>
        Bun.spawn([process.execPath, ENTRY, "add", `echo together-${i}`], { env, stdout: "ignore", stderr: "pipe" })
      );
      const errors: string[] = [];
      for (const p of adds) {
        await p.exited;
        const err = (await new Response(p.stderr).text()).trim();
        if (err) errors.push(err);
      }
      expect(errors).toEqual([]);

      const db = new Database(join(data, "shellwise", "history.db"), { readonly: true });
      try {
        const row = db.query("SELECT count(*) AS n FROM commands WHERE command LIKE 'echo together-%'").get() as { n: number };
        expect(row.n).toBe(N);
      } finally {
        db.close();
      }
    }
  }, 60_000);
});
