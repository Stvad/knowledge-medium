import * as Babel from '@babel/standalone'

// Bump when the Babel preset list / transform options change so older
// in-memory cache entries don't deliver wrong-shaped output.
const COMPILER_VERSION = '1'

export type ExtensionModule = Record<string, unknown>

export interface CompileResult {
  module: ExtensionModule
  contentHash: string
}

// L1: contentHash -> in-flight or resolved compile.
//
// Same content compiled from any block returns the same module instance,
// which is what we want — extensions are pure values keyed by source. The
// in-flight promise also dedupes concurrent compiles of the same content.
//
// Note: L1 is currently unbounded. For the workspace sizes we target this
// is fine (a workspace with 50 extension blocks each edited 10 times is
// 500 small entries). LRU eviction is a follow-up.
const compileByHash = new Map<string, Promise<ExtensionModule>>()

// L2: blockId -> { contentHash, modulePromise }.
//
// Lets unchanged blocks return the *same* module reference across
// multiple resolutions — critical for renderer modules so React doesn't
// unmount/remount on every refreshAppRuntime.
const moduleByBlock = new Map<
  string,
  {contentHash: string, modulePromise: Promise<ExtensionModule>}
>()

// Underlying compile is injectable so tests can drive cache behavior
// without depending on jsdom's blob-URL dynamic-import support.
export type CompileImpl = (content: string) => Promise<ExtensionModule>

let compileImpl: CompileImpl = defaultCompileViaBabelBlob

export function __setCompileImplForTest(impl: CompileImpl): () => void {
  const previous = compileImpl
  compileImpl = impl
  return () => {
    compileImpl = previous
  }
}

export function __resetCompileCacheForTest(): void {
  compileByHash.clear()
  moduleByBlock.clear()
}

const hexEncoder = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

async function hashContent(content: string): Promise<string> {
  // Salt with COMPILER_VERSION so a transform-config change globally
  // shifts every key (forcing recompilation).
  const data = new TextEncoder().encode(`${COMPILER_VERSION}:${content}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return hexEncoder(new Uint8Array(digest))
}

async function defaultCompileViaBabelBlob(content: string): Promise<ExtensionModule> {
  const transpiled = Babel.transform(content, {
    filename: 'extension-block.tsx',
    presets: ['react', 'typescript'],
  }).code
  if (!transpiled) throw new Error('Transpiled extension code is empty')

  const blob = new Blob([transpiled], {type: 'text/javascript'})
  const blobUrl = URL.createObjectURL(blob)
  try {
    const module = (await import(/* @vite-ignore */ blobUrl)) as ExtensionModule
    return module
  } finally {
    // Revoke as soon as the module's resolved — the JS engine has the
    // module recorded against this URL and won't fetch it again. The old
    // renderer pipeline leaked these.
    URL.revokeObjectURL(blobUrl)
  }
}

/**
 * Compile a block's content into a module. Caches by content hash (L1)
 * and by blockId (L2) so unchanged blocks return identical module
 * references across runtime resolutions.
 *
 * Throws if compilation fails — caller is expected to catch and report.
 */
export async function compileExtensionModule(
  content: string,
  blockId: string,
): Promise<CompileResult> {
  const contentHash = await hashContent(content)

  // L2 hit: same block + same content → reuse the module reference.
  const cachedForBlock = moduleByBlock.get(blockId)
  if (cachedForBlock?.contentHash === contentHash) {
    const module = await cachedForBlock.modulePromise
    return {module, contentHash}
  }

  // L1 hit: same content as something we've compiled before (possibly
  // for a different block). Two blocks with the same source share the
  // same module instance — extensions are values, identity follows
  // source.
  let modulePromise = compileByHash.get(contentHash)
  if (!modulePromise) {
    modulePromise = compileImpl(content)
    compileByHash.set(contentHash, modulePromise)
    // Don't poison the cache forever on a transient failure: drop the
    // rejected promise from BOTH cache layers so the next call retries.
    // L2 cleanup needs blockId from this scope; do both here.
    modulePromise.catch(() => {
      if (compileByHash.get(contentHash) === modulePromise) {
        compileByHash.delete(contentHash)
      }
      const l2 = moduleByBlock.get(blockId)
      if (l2?.modulePromise === modulePromise) {
        moduleByBlock.delete(blockId)
      }
    })
  }

  // Update L2 to point at this contentHash. Replaces any prior entry
  // for the block (whose content has changed).
  moduleByBlock.set(blockId, {contentHash, modulePromise})

  const module = await modulePromise
  return {module, contentHash}
}

/**
 * Drop a block's entry from L2. Use when a block is deleted so its
 * modulePromise is eligible for GC. (L1 entry under the old hash may
 * survive — that's acceptable since other blocks could share it.)
 */
export function evictBlockFromCache(blockId: string): void {
  moduleByBlock.delete(blockId)
}
