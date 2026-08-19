import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isErrnoException } from '@knowledge-medium/agent-cli/config'

/**
 * Atomically create `file` holding `contents`, if and only if it does not
 * already exist. Returns true when THIS call created it, false when another
 * writer already held it (whose content the caller can now read).
 *
 * The write goes to a PRIVATE temp file in the same directory and is then
 * `fs.link`-ed into place. `link` is the atomic create-if-absent primitive: it
 * fails EEXIST if the destination exists, and — crucially — the destination
 * only ever springs into existence already-complete, so a concurrent reader
 * sees ENOENT or the full contents, never an empty/partial file.
 * `writeFile(…, {flag:'wx'})` cannot offer that: it creates the target empty
 * and fills it in a SECOND step, opening a window a concurrent reader can
 * observe (and, in the worst case, reclaim) mid-write. This is the same
 * primitive `pidfile.ts` relies on for its create path.
 *
 * The temp name carries 128 bits of randomness, so two concurrent callers in
 * one process (same pid) can't collide on it and clobber each other's write —
 * no `wx` guard on the temp is needed.
 *
 * The caller must ensure `path.dirname(file)` exists. Cleanup of the temp is
 * best-effort in a `finally`: a failure to remove it must never mask the real
 * result (a thrown cleanup error would otherwise replace a successful return).
 */
export const createFileExclusive = async (
  file: string,
  contents: string,
  opts: {mode?: number} = {},
): Promise<boolean> => {
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`)
  try {
    await fs.writeFile(tmp, contents, opts.mode !== undefined ? {mode: opts.mode} : {})
    try {
      await fs.link(tmp, file)
      return true
    } catch (error) {
      if (isErrnoException(error) && error.code === 'EEXIST') return false // lost the create race
      // A filesystem without hardlink support (FAT/exFAT, some FUSE/network
      // mounts) fails link with one of these rather than EEXIST. Surface an
      // actionable error instead of a bare errno; the original is kept as cause.
      if (isErrnoException(error) && ['EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'ENOSYS'].includes(error.code ?? '')) {
        throw new Error(
          `Could not atomically create ${file} (link failed: ${error.code}). ` +
          `This filesystem may not support hardlinks — use a local filesystem for the agent-runtime config dir.`,
          {cause: error},
        )
      }
      throw error
    }
  } finally {
    await fs.rm(tmp, {force: true}).catch(() => {}) // best-effort; never mask the result
  }
}
