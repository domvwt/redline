/**
 * Registry of files the daemon itself just wrote, so the file watcher can
 * distinguish our writes from external ones (Claude, git, other editors).
 * Marks are CONSUMED on first watcher hit: with awaitWriteFinish each write
 * produces one change event, and consuming immediately means a genuine
 * external edit arriving right after our own write is not swallowed.
 */
const recent = new Map<string, number>();
const WINDOW_MS = 1500;

export function markOwnWrite(absPath: string): void {
  recent.set(absPath, Date.now());
}

export function isOwnWrite(absPath: string): boolean {
  const at = recent.get(absPath);
  if (at === undefined) return false;
  recent.delete(absPath); // consume
  return Date.now() - at <= WINDOW_MS;
}
