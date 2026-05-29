import { closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'fs'
import { dirname } from 'path'

// Atomic-write helper used for every on-disk file that holds
// load-bearing state (settings.enc, sessions.json, etc.).
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

type BufferWriter = (fd: number, buffer: Buffer, offset: number, length: number) => number

export function writeBufferFullySync(
  fd: number,
  bytes: Buffer,
  writer: BufferWriter = writeSync,
) {
  let offset = 0
  while (offset < bytes.length) {
    // All callers route through this bounded atomic persistence helper; source-specific
    // validation happens before data reaches this low-level writer.
    // codeql[js/http-to-file-access]
    const written = writer(fd, bytes, offset, bytes.length - offset)
    if (!Number.isInteger(written) || written <= 0) {
      throw new Error('Atomic write failed before all bytes were written')
    }
    offset += written
  }
}

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
  try { unlinkSync(tempPath) } catch { /* stale temp from a crashed writer is harmless if absent */ }

  let fd: number | null = null
  try {
    fd = openSync(tempPath, 'w', mode)
    if (process.platform !== 'win32') {
      try {
        fchmodSync(fd, mode)
      } catch {
        // openSync(..., mode) already applies permissions on creation. Some
        // filesystems reject chmod-on-fd, and that should not turn a durable
        // write into a persistence failure.
      }
    }
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data
    writeBufferFullySync(fd, bytes)
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
