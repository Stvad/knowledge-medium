import {
  getCompiledModuleCache,
  type CompiledModuleCache,
  type CompiledRecord,
} from '@/extensions/compiledModuleCache.js'

// Bump when the Babel preset list / transform options change so older
// cache entries (in-memory OR persisted) don't deliver wrong-shaped
// output. This is checked against the persisted record's
// `compilerVersion`, NOT folded into the source hash — a compiler bump
// must invalidate cached *output* without looking like a *source*
// change (which Phase 2 / #67 would treat as needing re-approval).
const COMPILER_VERSION = '1'

export type ExtensionModule = Record<string, unknown>

export interface CompileResult {
  module: ExtensionModule
  /** Pure SHA-256 of the block source (no compiler-version salt). */
  contentHash: string
}

/**
 * In-memory compile cache. The app uses a single shared instance (lives
 * for the lifetime of the page); tests construct their own instances to
 * avoid cross-test pollution from the module-level singleton.
 *
 * This sits ABOVE the persistent {@link CompiledModuleCache}: an L1/L2
 * hit returns a live module reference with no IndexedDB round-trip; only
 * an L1 miss consults the persistent cache (and only a persistent miss
 * loads Babel).
 */
export interface CompileCache {
  // L1: contentHash -> in-flight or resolved compile.
  // Same content from any block returns the same module instance.
  // Also dedupes concurrent compiles of the same content.
  byHash: Map<string, Promise<ExtensionModule>>

  // L2: blockId -> { contentHash, modulePromise }.
  // Lets unchanged blocks return the same module reference across
  // multiple resolutions — critical for renderer modules so React
  // doesn't unmount/remount on every refreshAppRuntime.
  byBlock: Map<
    string,
    {contentHash: string, modulePromise: Promise<ExtensionModule>}
  >
}

export const createCompileCache = (): CompileCache => ({
  byHash: new Map(),
  byBlock: new Map(),
})

// Process-wide singleton used by the loader in production. Bounded only
// by the number of distinct block content versions that have ever been
// compiled this session — eviction is a follow-up.
const defaultCache = createCompileCache()

// ──────────────────────────────────────────────────────────────────────
// Injectable pipeline seams (test-only overrides)
//
// The compile pipeline is two steps so the persistent cache can store
// the transpiled string and rebuild a module from it without Babel:
//   transpile(source) -> JS string   (the expensive, Babel-loading half)
//   instantiate(JS)   -> module       (blob-URL ESM import)
//
// `compileImpl` is a *full* override (source -> module) that bypasses
// persistence + Babel entirely — kept for the many existing tests that
// just want to hand back a module. When set, the persistent cache is not
// touched.
// ──────────────────────────────────────────────────────────────────────

export type CompileImpl = (content: string) => Promise<ExtensionModule>
export type TranspileImpl = (content: string) => Promise<string>
export type InstantiateImpl = (compiled: string) => Promise<ExtensionModule>

let compileImplOverride: CompileImpl | null = null
let transpileImpl: TranspileImpl = defaultTranspileViaBabel
let instantiateImpl: InstantiateImpl = defaultInstantiateViaBlob

export function __setCompileImplForTest(impl: CompileImpl): () => void {
  const previous = compileImplOverride
  compileImplOverride = impl
  return () => {
    compileImplOverride = previous
  }
}

export function __setTranspileImplForTest(impl: TranspileImpl): () => void {
  const previous = transpileImpl
  transpileImpl = impl
  return () => {
    transpileImpl = previous
  }
}

export function __setInstantiateImplForTest(impl: InstantiateImpl): () => void {
  const previous = instantiateImpl
  instantiateImpl = impl
  return () => {
    instantiateImpl = previous
  }
}

export function __resetCompileCacheForTest(): void {
  defaultCache.byHash.clear()
  defaultCache.byBlock.clear()
}

const hexEncoder = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** Pure SHA-256 of the source. The compiler version is intentionally NOT
 *  mixed in here — see {@link COMPILER_VERSION}. */
async function hashSource(content: string): Promise<string> {
  const data = new TextEncoder().encode(content)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return hexEncoder(new Uint8Array(digest))
}

/** Transpile TS/JSX source to JS. Babel is loaded with a dynamic
 *  `import()` so `@babel/standalone` (~0.85 MB gz) leaves the eager
 *  startup preload set (#167) — it's fetched/evaluated only here, on a
 *  genuine compile-cache miss. */
async function defaultTranspileViaBabel(content: string): Promise<string> {
  const Babel = await import('@babel/standalone')
  const transpiled = Babel.transform(content, {
    filename: 'extension-block.tsx',
    presets: ['react', 'typescript'],
  }).code
  if (!transpiled) throw new Error('Transpiled extension code is empty')
  return transpiled
}

/** Build an ESM module from already-transpiled JS via a blob URL. This
 *  is the only step that touches the network/loader, and the only step
 *  that runs on a persistent-cache hit (no Babel). */
async function defaultInstantiateViaBlob(compiled: string): Promise<ExtensionModule> {
  const blob = new Blob([compiled], {type: 'text/javascript'})
  const blobUrl = URL.createObjectURL(blob)
  try {
    return (await import(/* @vite-ignore */ blobUrl)) as ExtensionModule
  } finally {
    // Revoke as soon as the module's resolved — the JS engine has the
    // module recorded against this URL and won't fetch it again.
    URL.revokeObjectURL(blobUrl)
  }
}

/**
 * Produce a module for a block, consulting the persistent compile cache
 * before reaching for Babel:
 *
 *   1. persistent hit (same source hash + compiler version) → rebuild
 *      from the cached JS string. **Babel is not loaded.**
 *   2. miss → transpile (loads Babel), persist the output, instantiate.
 *
 * A flaky persistent read/write must never break extension loading, so
 * both are best-effort: a failed read is treated as a miss, a failed
 * write is logged and ignored (the freshly compiled module is still
 * returned).
 */
async function buildModule(
  content: string,
  sourceHash: string,
  blockId: string,
  persistent: CompiledModuleCache,
): Promise<ExtensionModule> {
  // Full test override: bypass persistence + Babel entirely.
  if (compileImplOverride) return compileImplOverride(content)

  let cached: CompiledRecord | undefined
  try {
    cached = await persistent.read(blockId)
  } catch (error) {
    console.warn(`Extension compile cache read failed for ${blockId}`, error)
  }
  if (
    cached &&
    cached.sourceHash === sourceHash &&
    cached.compilerVersion === COMPILER_VERSION
  ) {
    return instantiateImpl(cached.compiled)
  }

  const compiled = await transpileImpl(content)
  try {
    await persistent.write(blockId, {
      sourceHash,
      compiled,
      compilerVersion: COMPILER_VERSION,
    })
  } catch (error) {
    console.warn(`Extension compile cache write failed for ${blockId}`, error)
  }
  return instantiateImpl(compiled)
}

/**
 * Compile a block's content into a module. Caches by content hash (L1)
 * and by blockId (L2) so unchanged blocks return identical module
 * references across runtime resolutions, and persists transpiled output
 * (L3, via {@link CompiledModuleCache}) so a warm boot skips Babel.
 *
 * Pass a `cache` instance to scope in-memory caching (tests use this for
 * isolation), and a `persistent` instance to scope the cross-reload
 * cache. Omit either to use the process-wide singletons.
 *
 * Throws if compilation fails — caller is expected to catch and report.
 */
export async function compileExtensionModule(
  content: string,
  blockId: string,
  cache: CompileCache = defaultCache,
  persistent: CompiledModuleCache = getCompiledModuleCache(),
): Promise<CompileResult> {
  const contentHash = await hashSource(content)

  // L2 hit: same block + same content → reuse the module reference.
  const cachedForBlock = cache.byBlock.get(blockId)
  if (cachedForBlock?.contentHash === contentHash) {
    const module = await cachedForBlock.modulePromise
    return {module, contentHash}
  }

  // L1 hit: same content as something we've compiled before (possibly
  // for a different block). Two blocks with the same source share the
  // same module instance — extensions are values, identity follows
  // source.
  let modulePromise = cache.byHash.get(contentHash)
  if (!modulePromise) {
    modulePromise = buildModule(content, contentHash, blockId, persistent)
    cache.byHash.set(contentHash, modulePromise)
    // Don't poison the cache forever on a transient failure: drop the
    // rejected promise from BOTH cache layers so the next call retries.
    modulePromise.catch(() => {
      if (cache.byHash.get(contentHash) === modulePromise) {
        cache.byHash.delete(contentHash)
      }
      const l2 = cache.byBlock.get(blockId)
      if (l2?.modulePromise === modulePromise) {
        cache.byBlock.delete(blockId)
      }
    })
  }

  // Update L2 to point at this contentHash. Replaces any prior entry
  // for the block (whose content has changed).
  cache.byBlock.set(blockId, {contentHash, modulePromise})

  const module = await modulePromise
  return {module, contentHash}
}

/**
 * Drop a block's entry from L2. Use when a block is deleted so its
 * modulePromise is eligible for GC. (L1 entry under the old hash may
 * survive — that's acceptable since other blocks could share it.)
 *
 * Note: this clears only the in-memory layer. The persisted row is
 * keyed by blockId and overwritten on source change, so it's bounded;
 * wiring its deletion to extension uninstall is a Phase-2 concern.
 */
export function evictBlockFromCache(
  blockId: string,
  cache: CompileCache = defaultCache,
): void {
  cache.byBlock.delete(blockId)
}
