import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'fs'
import { dirname } from 'path'

// Atomic-write helper used for every on-disk file that holds
// load-bearing state (settings.enc, session-registry.json, etc.).
// Without this, a process crash mid-write can truncate the target
// and wipe the user's credentials or session index on next boot.
//
// The recipe is the POSIX-standard write-temp-then-rename pattern:
//   1. Open a unique sibling file with 0o600 perms.
//   2. Write, fsync so bytes are durable on disk — not just in the
//      kernel page cache.
//   3. Atomically rename over the target. rename(2) is atomic on
//      the same filesystem, so any crash after this point leaves
//      the NEW file visible under the target name; any crash
//      before leaves the OLD file untouched. Either way: no
//      partial-write window.
//
// The unique suffix (pid + counter) prevents two concurrent writers
// (e.g. two Electron instances during dev) from clobbering each
// other's temp files.
let tempCounter = 0

export function writeFileAtomic(
  targetPath: string,
  data: Buffer | string,
  options?: { mode?: number },
): void {
  const mode = options?.mode ?? 0o600
  tempCounter += 1
  const tempPath = `${targetPath}.tmp-${process.pid}-${tempCounter}`

  // Ensure the parent directory exists. Without this, a first-run
  // scenario (user-data dir not yet created) or a user who deleted
  // the settings folder mid-flight would get a raw ENOENT from
  // openSync, crashing the main process instead of self-healing.
  // mkdirSync with recursive:true is a no-op when the dir exists.
  mkdirSync(dirname(targetPath), { recursive: true })

  let fd: number | null = null
  try {
    fd = openSync(tempPath, 'w', mode)
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data
    writeSync(fd, bytes, 0, bytes.length)
    // fsync forces the bytes out of the page cache so a power-loss
    // between write() and close() doesn't lose them. Matters most for
    // credential files — an empty decrypt on reboot is worse than
    // losing the last write.
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tempPath, targetPath)
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* already failed — nothing more to do */ }
    }
    try { unlinkSync(tempPath) } catch { /* temp may not exist if open failed */ }
    throw err
  }
}
