/**
 * Answers one question for `localDbVfs.ts`: can this browser hold TWO
 * concurrent sync access handles on a single OPFS file?
 *
 * That is the whole requirement behind `OPFSWriteAheadVFS` — it needs
 * `createSyncAccessHandle({mode: 'readwrite-unsafe'})`, which Chromium
 * implements and Firefox/Safari (as of 2026-08) do not.
 *
 * This lives in a worker because `createSyncAccessHandle` does not exist on
 * `FileSystemFileHandle` in a window context at all — a main-thread probe
 * can only ever report "unsupported", including on browsers that support it.
 *
 * Opening ONE handle proves nothing: the exclusive default mode succeeds
 * everywhere. The second concurrent open is the actual test.
 */

const PROBE_FILE = '.km-write-ahead-probe'

// The `mode` option is in no DOM lib yet, and `FileSystemSyncAccessHandle`
// itself is only in some of the configs this file compiles under — so this is a
// standalone shape (only `close()` is needed) rather than an extension of
// `FileSystemFileHandle`, which would have to match the real return type.
interface ProbeAccessHandle {
  close(): void
}

interface UnsafeModeFileHandle {
  createSyncAccessHandle(options?: {mode?: string}): Promise<ProbeAccessHandle>
}

/**
 * `null` means the probe could not run — distinct from `false`, which means the
 * second handle was refused. The caller retries a `null` rather than acting on
 * it: a transient failure that resolves to "unsupported" sends this tab to
 * CoopSync while another tab may be moving the same database.
 *
 * Only the SECOND open is diagnostic. A browser without the mode ignores the
 * unknown option and hands back an ordinary exclusive handle, so the first open
 * succeeds there too and the second is what fails.
 */
const probe = async (): Promise<boolean | null> => {
  const root = await navigator.storage.getDirectory()
  const handle = (await root.getFileHandle(PROBE_FILE, {create: true})) as unknown as UnsafeModeFileHandle
  const opened: ProbeAccessHandle[] = []
  try {
    try {
      opened.push(await handle.createSyncAccessHandle({mode: 'readwrite-unsafe'}))
    } catch {
      return null
    }
    try {
      opened.push(await handle.createSyncAccessHandle({mode: 'readwrite-unsafe'}))
    } catch {
      return false
    }
    return true
  } finally {
    for (const access of opened) {
      try {
        access.close()
      } catch {
        // A close failure leaves the probe file behind; harmless.
      }
    }
    await root.removeEntry(PROBE_FILE).catch(() => {})
  }
}

self.onmessage = () => {
  probe().then(
    supported => self.postMessage({supported}),
    () => self.postMessage({supported: null}),
  )
}
