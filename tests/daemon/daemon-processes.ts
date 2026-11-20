// Finds `daemon _run` processes in the process table, for tests that must
// count daemons: one that lost its socket and pid file to another daemon is
// still listed here.

/**
 * Whether `commandLine` runs `<program> daemon _run`. Quotes are ignored: a
 * program path with a space is quoted on a Windows command line. Windows
 * paths compare case-insensitively.
 */
export function runsDaemon(commandLine: string, program: string): boolean {
  const norm = (s: string) => s.replace(/"/g, "").replace(/\s+/g, " ").trim();
  const line = norm(commandLine);
  const marker = norm(`${program} daemon _run`);
  return process.platform === "win32" ? line.toLowerCase().includes(marker.toLowerCase()) : line.includes(marker);
}

/**
 * Pids of every `<program> daemon _run` whose image is `image` (bun.exe for a
 * script, shellwise.exe for a compiled binary): Win32_Process on Windows,
 * `ps` elsewhere.
 */
export function daemonPids(image: string, program: string): number[] {
  if (process.platform === "win32") {
    const query = `Get-CimInstance Win32_Process -Filter "Name='${image}'" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`;
    const out = Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", query]).stdout.toString();
    return out
      .split(/\r?\n/)
      .filter((l) => runsDaemon(l.slice(l.indexOf(" ") + 1), program))
      .map((l) => parseInt(l));
  }
  // All processes, full command lines (-w twice: no width limit, whatever
  // COLUMNS or a terminal says), no header. Spelled the same in procps and
  // BSD/macOS ps, and without mixing their option styles.
  const out = Bun.spawnSync(["ps", "-A", "-ww", "-o", "pid=,args="]).stdout.toString();
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => runsDaemon(l.slice(l.indexOf(" ") + 1), program))
    .map((l) => parseInt(l));
}
