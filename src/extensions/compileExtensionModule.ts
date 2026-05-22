import * as Babel from '@babel/standalone'

// Bump when the Babel preset list / transform options change so older
// in-memory cache entries don't deliver wrong-shaped output.
const COMPILER_VERSION = '1'

export type ExtensionModule = Record<string, unknown>

export interface CompileResult {
  module: ExtensionModule
  contentHash: string
}

/**
 * A compile cache. The app uses a single shared instance (lives for
 * the lifetime of the page); tests construct their own instances to
 * avoid cross-test pollution from the module-level singleton.
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
  defaultCache.byHash.clear()
  defaultCache.byBlock.clear()
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

// Map from "@/foo.js" → "@/foo.tsx" / ".ts" / ".jsx" / "" (whichever
// file actually exists on disk). The kernel imports modules by their
// literal disk extension (`@/context/repo.tsx`, not `@/context/repo.js`);
// if extensions use the conventional `.js` suffix, the browser's module
// loader keys those as a *separate* entry from the kernel's `.tsx`
// entry — producing duplicate copies of every module-scoped singleton
// (most visibly React `createContext` calls: `useRepo` reads a fresh
// RepoContext, which `<RepoProvider>` never wrote to, → "useRepo must
// be used within a RepoContext"). The dev server's
// `canonicalize-js-extension` plugin (vite.config.ts) 302s `.js` to the
// canonical URL on the wire, but neither Chrome's module map nor
// Vite's client-side HMR registry dedupes across redirects: both key
// by the *requested* URL. So we have to rewrite specifiers in the
// extension source *before* `import()` is called, so the requested URL
// matches the kernel's.
const canonicalImportCache = new Map<string, string>()

const probeCanonicalPath = async (atPath: string): Promise<string | null> => {
  // atPath looks like "@/context/repo.js". The dev server serves the
  // file under multiple URLs but follows a redirect from `.js` to the
  // literal-extension URL. Resolving with `fetch` + `redirect: 'follow'`
  // surfaces the final URL the kernel actually loads.
  if (!atPath.startsWith('@/') || !atPath.endsWith('.js')) return null
  const cached = canonicalImportCache.get(atPath)
  if (cached !== undefined) return cached || null

  const resourcePath = atPath.replace(/^@\//, '/src/')
  try {
    const response = await fetch(resourcePath, {method: 'HEAD', redirect: 'follow'})
    if (!response.ok) {
      canonicalImportCache.set(atPath, '')
      return null
    }
    const finalUrl = new URL(response.url)
    if (!finalUrl.pathname.startsWith('/src/')) {
      canonicalImportCache.set(atPath, '')
      return null
    }
    const canonical = `@${finalUrl.pathname.slice('/src'.length)}`
    canonicalImportCache.set(atPath, canonical)
    return canonical
  } catch {
    canonicalImportCache.set(atPath, '')
    return null
  }
}

const IMPORT_SPECIFIER_RE = /(['"])(@\/[^'"]+\.js)\1/g

export function __resetCanonicalImportCacheForTest(): void {
  canonicalImportCache.clear()
}

export async function canonicalizeExtensionImports(source: string): Promise<string> {
  // Collect unique `@/foo.js` specifiers, probe each once.
  const specifiers = new Set<string>()
  for (const match of source.matchAll(IMPORT_SPECIFIER_RE)) {
    specifiers.add(match[2]!)
  }
  if (specifiers.size === 0) return source

  const replacements = new Map<string, string>()
  await Promise.all([...specifiers].map(async specifier => {
    const canonical = await probeCanonicalPath(specifier)
    if (canonical && canonical !== specifier) {
      replacements.set(specifier, canonical)
    }
  }))
  if (replacements.size === 0) return source

  return source.replace(IMPORT_SPECIFIER_RE, (full, quote, specifier) => {
    const canonical = replacements.get(specifier)
    return canonical ? `${quote}${canonical}${quote}` : full
  })
}

async function defaultCompileViaBabelBlob(content: string): Promise<ExtensionModule> {
  const transpiled = Babel.transform(content, {
    filename: 'extension-block.tsx',
    presets: ['react', 'typescript'],
  }).code
  if (!transpiled) throw new Error('Transpiled extension code is empty')

  const canonicalized = await canonicalizeExtensionImports(transpiled)

  const blob = new Blob([canonicalized], {type: 'text/javascript'})
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
 * Pass a `cache` instance to scope caching (tests use this for
 * isolation). Omit to use the process-wide singleton.
 *
 * Throws if compilation fails — caller is expected to catch and report.
 */
export async function compileExtensionModule(
  content: string,
  blockId: string,
  cache: CompileCache = defaultCache,
): Promise<CompileResult> {
  const contentHash = await hashContent(content)

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
    modulePromise = compileImpl(content)
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
 */
export function evictBlockFromCache(
  blockId: string,
  cache: CompileCache = defaultCache,
): void {
  cache.byBlock.delete(blockId)
}
