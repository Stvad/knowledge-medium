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
  /** Pure SHA-256 of the source this module was built from (no
   *  compiler-version salt). For an approved load this is the APPROVED
   *  source hash (the pin), not the live block content's hash. */
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
 *  mixed in here — see {@link COMPILER_VERSION}. This is the hash the
 *  device-local approval pins, and what the loader compares against
 *  `hashExtensionSource(live block.content)` to detect source drift. */
export async function hashExtensionSource(content: string): Promise<string> {
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
 * Resolve a module through the in-memory L1 (content-hash) / L2 (blockId)
 * cache, building it via `factory` only on a miss. `hashKey` is the
 * content hash that keys L1 — for an approved load it's the APPROVED
 * source hash (the pin), so two blocks sharing the same approved source
 * share one module instance, and a re-resolve of an unchanged pin returns
 * the same reference (React doesn't remount).
 *
 * A rejected build is dropped from BOTH layers so the next call retries
 * rather than caching the failure forever.
 */
function resolveCachedModule(
  cache: CompileCache,
  hashKey: string,
  blockId: string,
  factory: () => Promise<ExtensionModule>,
): Promise<ExtensionModule> {
  // L2 hit: same block + same hash → reuse the module reference.
  const cachedForBlock = cache.byBlock.get(blockId)
  if (cachedForBlock?.contentHash === hashKey) return cachedForBlock.modulePromise

  // L1 hit: same content as something we've built before (possibly for a
  // different block). Extensions are values; identity follows source.
  let modulePromise = cache.byHash.get(hashKey)
  if (!modulePromise) {
    modulePromise = factory()
    cache.byHash.set(hashKey, modulePromise)
    modulePromise.catch(() => {
      if (cache.byHash.get(hashKey) === modulePromise) cache.byHash.delete(hashKey)
      const l2 = cache.byBlock.get(blockId)
      if (l2?.modulePromise === modulePromise) cache.byBlock.delete(blockId)
    })
  }
  cache.byBlock.set(blockId, {contentHash: hashKey, modulePromise})
  return modulePromise
}

/**
 * Runtime shape-guard that tells a real Phase-2 approval record apart from
 * a leftover Phase-1 (#167) compile-cache row.
 *
 * THIS IS A SECURITY CHECK (#67), not a defensive nicety. Phase 1 shipped
 * the SAME `km-extension-compiled` store and auto-wrote a row
 * `{sourceHash, compiled, compilerVersion}` on EVERY compile (implicit
 * auto-approve), with no `approvedSource`/`approvedAt`. On every upgraded
 * profile that store is already full of such rows. If row-presence alone
 * counted as trust, every already-compiled extension would skip
 * `needs-approval` and execute its cached JS with no explicit approval —
 * defeating the gate for the entire existing fleet. A row is an approval
 * ONLY if it carries the Phase-2 fields; legacy rows read as "no approval"
 * and are overwritten by the next real `approveExtension`.
 */
const isApprovalRecord = (row: unknown): row is CompiledRecord => {
  if (!row || typeof row !== 'object') return false
  const r = row as Partial<CompiledRecord>
  return (
    typeof r.approvedSource === 'string' &&
    typeof r.approvedAt === 'number' &&
    typeof r.sourceHash === 'string' &&
    typeof r.compiled === 'string' &&
    typeof r.compilerVersion === 'string'
  )
}

/** Three-way result of an approval lookup. The `unreadable` arm exists so
 *  callers whose fallback is to (re-)pin LIVE source — the settings enable
 *  path — can FAIL CLOSED on a transient store error instead of mistaking
 *  a real pin for "never approved" and silently adopting a drifted source.
 *  `unapproved` covers both a missing row and a rejected legacy Phase-1 row
 *  (either is eligible for a first real approval). */
export type ApprovalLookup =
  | {status: 'approved', record: CompiledRecord}
  | {status: 'unapproved'}
  | {status: 'unreadable'}

/** Distinguish "no approval" from "couldn't read the approval store". Use
 *  this (not {@link readApproval}) anywhere the no-approval fallback is to
 *  pin live source. */
export async function lookupApproval(
  blockId: string,
  persistent: CompiledModuleCache = getCompiledModuleCache(),
): Promise<ApprovalLookup> {
  let row: CompiledRecord | undefined
  try {
    row = await persistent.read(blockId)
  } catch (error) {
    console.warn(`Extension approval read failed for ${blockId}`, error)
    return {status: 'unreadable'}
  }
  return isApprovalRecord(row) ? {status: 'approved', record: row} : {status: 'unapproved'}
}

/** Best-effort read of a block's device-local approval record. A flaky
 *  read (or absence, or a legacy non-approval row) is reported as "no
 *  approval", which surfaces as the cross-device "enable here?" prompt
 *  rather than silently running anything — correct for the LOADER, which
 *  simply declines to run on `undefined`. Callers whose no-approval
 *  fallback is to pin live source must use {@link lookupApproval} so they
 *  can fail closed on a transient read error. See {@link isApprovalRecord}
 *  for why legacy rows are rejected. */
export async function readApproval(
  blockId: string,
  persistent: CompiledModuleCache = getCompiledModuleCache(),
): Promise<CompiledRecord | undefined> {
  const lookup = await lookupApproval(blockId, persistent)
  return lookup.status === 'approved' ? lookup.record : undefined
}

/** Best-effort write — a flaky persist must never reject the operation
 *  that triggered it (the in-memory module is still returned/usable this
 *  session; the next boot just re-prompts for approval). */
async function persistApproval(
  persistent: CompiledModuleCache,
  blockId: string,
  record: CompiledRecord,
): Promise<void> {
  try {
    await persistent.write(blockId, record)
  } catch (error) {
    console.warn(`Extension approval write failed for ${blockId}`, error)
  }
}

/**
 * Grant (or refresh) the device-local approval for a block: transpile the
 * source and DURABLY persist the approval row. This is the ONLY path that
 * loads Babel and writes an approval row — the only place trust is
 * established (#67). Callers are the settings "enable/update" control and
 * the agent `enable-extension` command; both pass the CURRENT live
 * `block.content` as the approved source.
 *
 * Deliberately DECOUPLED from running the module (#67 review):
 *   - It does NOT instantiate. Approving a block vouches the SOURCE, not its
 *     runtime behaviour — a module that transpiles but throws at import/eval
 *     must NOT abort the approve/enable action. That runtime error surfaces
 *     through the loader's `errorReporter` after intent is applied, where it
 *     belongs (and where the row still shows in settings for recovery).
 *   - The persist is NOT best-effort. If the trust row can't be written
 *     (quota / private-mode / aborted tx) the approve has FAILED and throws,
 *     so callers don't set "enabled" intent against a non-existent approval
 *     (which would silently loop on needs-approval). Contrast the load
 *     path's compiler-bump rewrite, which stays best-effort.
 *
 * Idempotent for unchanged, already-approved source (no Babel, no write).
 * Throws if the source can't be transpiled (syntax error — nothing to pin)
 * or the approval can't be persisted. Returns the approved source hash.
 */
export async function approveExtension(
  blockId: string,
  source: string,
  persistent: CompiledModuleCache = getCompiledModuleCache(),
): Promise<{contentHash: string}> {
  const sourceHash = await hashExtensionSource(source)

  // Idempotent: unchanged source already approved under the current compiler
  // → the pin is current, nothing to do (and no Babel). `readApproval`
  // rejects legacy Phase-1 rows, so an upgraded profile still re-approves.
  const existing = await readApproval(blockId, persistent)
  if (existing?.sourceHash === sourceHash && existing.compilerVersion === COMPILER_VERSION) {
    return {contentHash: sourceHash}
  }

  // `compiled` is the pinned output. Under a full compile override (tests)
  // there's no real transpile; store the source as a placeholder the
  // override-aware load path ignores. A transpile failure (bad syntax)
  // propagates — there's nothing to pin.
  const compiled = compileImplOverride ? source : await transpileImpl(source)

  // Throwing write (NOT persistApproval's swallow): a failed persist must
  // fail the approve so the caller doesn't proceed to set intent. Written
  // per-block directly (approval is per-block), never via the content-keyed
  // in-memory cache.
  await persistent.write(blockId, {
    sourceHash,
    approvedSource: source,
    compiled,
    compilerVersion: COMPILER_VERSION,
    approvedAt: Date.now(),
  })
  return {contentHash: sourceHash}
}

/**
 * Instantiate a block from its APPROVED record (the pin) — never from live
 * content. This is the load path the runtime uses for an
 * already-approved, enabled block: no Babel on the warm path.
 *
 *   - compiler matches → instantiate the pinned `compiled` string.
 *   - compiler bumped → recompile from `approvedSource` (loads Babel) and
 *     re-pin the fresh output. We recompile the APPROVED source, not the
 *     live content, so a compiler bump can never become a backdoor for
 *     drifted (un-approved) code.
 *
 * `contentHash` in the result is the approved hash (so callers can compare
 * it against the live content hash to know whether an update is pending).
 */
export async function loadApprovedExtension(
  blockId: string,
  approval: CompiledRecord,
  cache: CompileCache = defaultCache,
  persistent: CompiledModuleCache = getCompiledModuleCache(),
): Promise<CompileResult> {
  const module = await resolveCachedModule(cache, approval.sourceHash, blockId, async () => {
    if (compileImplOverride) return compileImplOverride(approval.approvedSource)
    if (approval.compilerVersion !== COMPILER_VERSION) {
      const compiled = await transpileImpl(approval.approvedSource)
      // Deliberate (#67): this is the ONLY write on the load path, and it
      // re-pins the SAME approved `sourceHash` (only the compiled output +
      // compilerVersion change). Loading must never establish trust for a
      // new/changed source — that is exclusively `approveExtension`'s job.
      // Do not "optimize" by persisting live content here.
      await persistApproval(persistent, blockId, {...approval, compiled, compilerVersion: COMPILER_VERSION})
      return instantiateImpl(compiled)
    }
    return instantiateImpl(approval.compiled)
  })
  return {module, contentHash: approval.sourceHash}
}

/**
 * Compile LIVE source into a module WITHOUT persisting or requiring an
 * approval. Used only by the agent install `--verify` path, which resolves
 * a brand-new block's source in an isolated runtime to inspect its
 * contributions before any approval exists. Never used on the user-facing
 * load path — that one runs only approved, pinned output.
 */
export async function compileForVerification(
  content: string,
  blockId: string,
  cache: CompileCache = defaultCache,
): Promise<CompileResult> {
  const contentHash = await hashExtensionSource(content)
  const module = await resolveCachedModule(cache, contentHash, blockId, () =>
    compileImplOverride ? compileImplOverride(content) : transpileImpl(content).then(instantiateImpl),
  )
  return {module, contentHash}
}

/**
 * Revoke a block's device-local approval: delete the persisted row and
 * drop the in-memory L2 entry, so the block stops running on the next
 * resolve. Best-effort (a failed delete must not break disable/uninstall);
 * the worst case is an orphaned row that a later re-approval overwrites (or
 * that a full "clear site data" wipe drops).
 */
export async function revokeExtensionApproval(
  blockId: string,
  persistent: CompiledModuleCache = getCompiledModuleCache(),
  cache: CompileCache = defaultCache,
): Promise<void> {
  evictBlockFromCache(blockId, cache)
  try {
    await persistent.delete(blockId)
  } catch (error) {
    console.warn(`Extension approval delete failed for ${blockId}`, error)
  }
}

/**
 * Drop a block's entry from the in-memory L2 cache. Use when a block is
 * deleted/revoked so its modulePromise is eligible for GC. (The L1 entry
 * under the old hash may survive — acceptable since other blocks could
 * share it.) Does not touch the persisted approval; use
 * {@link revokeExtensionApproval} for that.
 */
export function evictBlockFromCache(
  blockId: string,
  cache: CompileCache = defaultCache,
): void {
  cache.byBlock.delete(blockId)
}
