// Loaded before every test file (bunfig.toml). Every CLI, shell and daemon a
// test starts inherits this environment: keep the daily update check (a
// request to the npm registry, and a notice on stdout) out of all of them.
process.env.SHELLWISE_NO_UPDATE_CHECK = "1";
