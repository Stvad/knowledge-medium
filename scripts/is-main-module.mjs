import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Whether the module at `metaUrl` is the script node was started with — the
 * entry-point check every hook script in scripts/ shares. Exact-path
 * comparison: a suffix match would run a hook at import time from any sibling
 * whose name this file's happens to end with. Both sides realpathed: node
 * resolves the ESM entry through symlinks while argv keeps the literal path,
 * and a mismatch silently disables the hook.
 */
export const isMainModule = metaUrl => {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(process.argv[1]))
  } catch {
    return fileURLToPath(metaUrl) === resolve(process.argv[1])
  }
}
