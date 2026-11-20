// Loaded before every test file (bunfig.toml). Every CLI, shell and daemon a
// test starts inherits this environment: keep the daily update check (a
// request to the npm registry, and a notice on stdout) out of all of them.
process.env.SHELLWISE_NO_UPDATE_CHECK = "1";

// On Windows %TEMP% is often an 8.3 short path (C:\Users\RUNNER~1\...), while
// shells and .NET report the long one. Give every test, and every process it
// starts, the long form so paths built from tmpdir() compare equal to theirs.
if (process.platform === "win32") {
  const { realpathSync } = await import("fs");
  const { tmpdir } = await import("os");
  const long = realpathSync.native(tmpdir());
  process.env.TEMP = long;
  process.env.TMP = long;
}
