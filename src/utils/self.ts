/**
 * Argv prefix that re-runs this exact program. A compiled binary reports a
 * virtual entry point (`/$bunfs/...` on POSIX, `B:/~BUN/...` on Windows) and
 * its real path in execPath; script mode is the reverse (execPath is bun).
 */
export function isCompiled(main: string = Bun.main): boolean {
  return main.startsWith("/$bunfs") || /^[A-Za-z]:[\/]~BUN[\/]/.test(main);
}

export function selfCommand(): string[] {
  return isCompiled() ? [process.execPath] : [process.execPath, Bun.main];
}
