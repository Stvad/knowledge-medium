import {extensionModuleParser, parseExtensionSource, sourcePinnedImports} from '@knowledge-medium/agent-cli/extensionImportSyntax'
import {
  getCompiledModuleCache,
  type CompiledModuleCache,
  type CompiledRecord,
} from '@/extensions/compiledModuleCache.js'
import {buildApprovalRecord, COMPILER_VERSION, hashExtensionSource} from './buildApprovalRecord.js'
import {linkVendoredImports} from './extensionImportPolicy.js'
export {COMPILER_VERSION, hashExtensionSource} from './buildApprovalRecord.js'
export {EXTENSION_BABEL_PRESETS} from './transpileExtension.js'

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
 * This sits ABOVE the persistent {@link CompiledModuleCache}: an in-memory
 * hit returns a live module reference with no IndexedDB round-trip; only
 * an in-memory miss consults the persistent cache (and only a persistent miss
 * loads Babel).
 */
export interface CompileCache {
  // blockId + contentHash -> in-flight or resolved compile.
  // A live module belongs to one extension block: its declaration handles may
  // be bound to that block's durable seed identities. This still dedupes
  // concurrent compiles of the same block content.
  unpersistedUpgrades: Map<string, CompiledRecord>
  byBlockAndHash: Map<string, Map<string, Promise<CompileResult>>>
}

export const createCompileCache = (): CompileCache => ({
  byBlockAndHash: new Map(),
  unpersistedUpgrades: new Map(),
})

// Process-wide singleton used by the loader in production. Content versions
// remain cached until their owning block is evicted or the page tears down.
const defaultCache = createCompileCache()

export type CompileImpl = (content: string) => Promise<ExtensionModule>
export type BeforeExtensionEvaluation = () => Promise<void>

export interface ExtensionCompilePlatform {
  instantiate: (record: CompiledRecord, blockId: string, beforeEvaluate?: BeforeExtensionEvaluation) => Promise<ExtensionModule>
  allowUnpinnedLive: boolean
}

let compileImplOverride: CompileImpl | null = null
let platform: ExtensionCompilePlatform = {instantiate: defaultInstantiateViaBlob, allowUnpinnedLive: true}

export function setExtensionCompilePlatform(next: ExtensionCompilePlatform): () => void {
  const previous = platform
  platform = next
  return () => { platform = previous }
}

export function __setCompileImplForTest(impl: CompileImpl): () => void {
  const previous = compileImplOverride
  compileImplOverride = impl
  return () => {
    compileImplOverride = previous
  }
}

export function __resetCompileCacheForTest(): void {
  defaultCache.byBlockAndHash.clear()
  defaultCache.unpersistedUpgrades.clear()
}

async function linkExtensionRecord(
  record: CompiledRecord, urlFor: (integrity: string, bytes: Uint8Array<ArrayBuffer>) => string,
): Promise<string> {
  if (!record.compiled.includes('km-vendored:')) return record.compiled
  return linkVendoredImports(await extensionModuleParser(), record.compiled, integrity => {
    const bytes = record.vendored?.[integrity]
    if (!bytes) throw new Error(`Missing approved import ${integrity}`)
    return urlFor(integrity, bytes)
  })
}

/** Build an ESM module from already-transpiled JS via a blob URL. This
 *  is the only step that touches the network/loader, and the only step
 *  that runs on a persistent-cache hit (no Babel). */
async function defaultInstantiateViaBlob(record: CompiledRecord): Promise<ExtensionModule> {
  const urls = new Map<string, string>()
  try {
    const compiled = await linkExtensionRecord(record, (integrity, bytes) => {
      const previous = urls.get(integrity)
      if (previous) return previous
      const url = URL.createObjectURL(new Blob([bytes], {type: 'text/javascript'}))
      urls.set(integrity, url)
      return url
    })
    const entry = URL.createObjectURL(new Blob([compiled], {type: 'text/javascript'}))
    try {
      return await import(/* @vite-ignore */ entry) as ExtensionModule
    } finally {
      URL.revokeObjectURL(entry)
    }
  } finally {
    for (const url of urls.values()) URL.revokeObjectURL(url)
  }
}

/**
 * Resolve a module through the block-scoped in-memory cache
 * by building it via `factory` only on a miss. `hashKey` is the
 * content hash that participates in the cache key — for an approved load it's
 * the APPROVED source hash (the pin). A re-resolve of an unchanged pin returns
 * the same reference (React doesn't remount), while a different block gets a
 * separate live module even when its source is identical.
 *
 * A rejected build is dropped so the next call retries rather than caching
 * the failure forever.
 */
function resolveCachedModule(
  cache: CompileCache,
  hashKey: string,
  blockId: string,
  factory: () => Promise<CompileResult>,
): Promise<CompileResult> {
  let modulesForBlock = cache.byBlockAndHash.get(blockId)
  if (!modulesForBlock) {
    modulesForBlock = new Map()
    cache.byBlockAndHash.set(blockId, modulesForBlock)
  }
  // Cache hit: same block and content as something we've built before.
  let modulePromise = modulesForBlock.get(hashKey)
  if (!modulePromise) {
    modulePromise = factory()
    modulesForBlock.set(hashKey, modulePromise)
    modulePromise.catch(() => {
      if (modulesForBlock.get(hashKey) === modulePromise) {
        modulesForBlock.delete(hashKey)
        if (
          modulesForBlock.size === 0 &&
          cache.byBlockAndHash.get(blockId) === modulesForBlock
        ) {
          cache.byBlockAndHash.delete(blockId)
        }
      }
    })
  }
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

async function upgradeApproval(
  blockId: string, approval: CompiledRecord, cache: CompileCache, persistent: CompiledModuleCache,
): Promise<CompiledRecord> {
  const cached = cache.unpersistedUpgrades.get(blockId)
  if (cached?.sourceHash === approval.sourceHash) return cached

  const compiled = await prepareRecord(blockId, approval.approvedSource, approval.vendored)
  compiled.approvedAt = approval.approvedAt
  compiled.sourceHash = approval.sourceHash
  let stillApproved: boolean
  try {
    stillApproved = await persistent.updateCompilation(blockId, approval, compiled)
  } catch (error) {
    // The loader checks the persisted grant again on every refresh.
    console.warn(`Extension compilation cache write failed for ${blockId}`, error)
    cache.unpersistedUpgrades.set(blockId, compiled)
    return compiled
  }
  if (!stillApproved) throw new Error('Extension approval changed during recompilation')
  cache.unpersistedUpgrades.delete(blockId)
  return compiled
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
  frozen?: CompiledRecord['vendored'],
): Promise<{contentHash: string}> {
  const sourceHash = await hashExtensionSource(source)
  const existing = await readApproval(blockId, persistent)
  if (existing?.sourceHash === sourceHash && existing.compilerVersion === COMPILER_VERSION
    && [...(await pinnedImports(source)).values()].every(integrity => existing.vendored?.[integrity])) {
    return {contentHash: sourceHash}
  }
  const record = await prepareRecord(blockId, source, frozen)
  await persistent.write(blockId, record)
  return {contentHash: sourceHash}
}

async function pinnedImports(source: string) {
  if (compileImplOverride) return new Map<string, string>()
  return sourcePinnedImports(await parseExtensionSource(source))
}

function prepareRecord(blockId: string, source: string, frozen?: CompiledRecord['vendored']) {
  return buildApprovalRecord(blockId, source, {frozen, allowUnpinnedLive: platform.allowUnpinnedLive},
    compileImplOverride ? async content => ({compiled: content, pinnedImports: new Map()}) : undefined)
}

async function instantiateRecord(
  blockId: string, record: CompiledRecord, beforeEvaluate?: BeforeExtensionEvaluation,
): Promise<CompileResult> {
  if (record.importsUnpinned && !platform.allowUnpinnedLive) throw new Error('Unpinned HTTPS import')
  const module = compileImplOverride ? await compileImplOverride(record.approvedSource)
    : await platform.instantiate(record, blockId, beforeEvaluate)
  return {module, contentHash: record.sourceHash}
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
  reportUnpinned?: (record: CompiledRecord) => void,
  beforeEvaluate?: BeforeExtensionEvaluation,
): Promise<CompileResult> {
  let record = approval
  if (approval.compilerVersion !== COMPILER_VERSION && !compileImplOverride) {
    record = await upgradeApproval(blockId, approval, cache, persistent)
  }
  // Keep the pin action available even if the live CDN fails during module linking.
  if (record.importsUnpinned) reportUnpinned?.(record)
  return resolveCachedModule(cache, record.sourceHash, blockId, () => instantiateRecord(blockId, record, beforeEvaluate))
}

/**
 * A source that could not be TRANSPILED, as opposed to one that transpiled and
 * then failed to run.
 *
 * The difference is whether the source can be PINNED: `approveExtension` stores
 * the transpiled output, so a transpile failure leaves the previous pin in
 * place and the old code running, while anything later still pins and still
 * takes effect at the next reload. A caller reasoning about what an install
 * will change needs to tell those apart, and the thrown error otherwise cannot
 * say which half it came from.
 */
export class ExtensionTranspileError extends Error {
  constructor(blockId: string, override readonly cause: unknown) {
    super(`Extension ${blockId} could not be transpiled: ${(cause as Error)?.message ?? cause}`)
    this.name = 'ExtensionTranspileError'
  }
}

/**
 * Compile LIVE source into a module WITHOUT persisting or requiring an
 * approval. Used by the agent install path, which resolves a block's source in
 * an isolated runtime to inspect its contributions before any approval exists.
 * Never used on the user-facing load path — that one runs only approved,
 * pinned output.
 */
export async function compileForVerification(
  content: string,
  blockId: string,
  cache: CompileCache = defaultCache,
): Promise<CompileResult> {
  const contentHash = await hashExtensionSource(content)
  return resolveCachedModule(cache, contentHash, blockId, async () => {
    let record: CompiledRecord
    try {
      record = await prepareRecord(blockId, content)
    } catch (error) {
      throw new ExtensionTranspileError(blockId, error)
    }
    return instantiateRecord(blockId, record)
  })
}

/**
 * Revoke a block's device-local approval: delete the persisted row and
 * drop its in-memory module entries, so the block stops running on the next
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
 * Drop every live module for a block from the in-memory caches. Use when a
 * block is deleted/revoked so its top-level closures and bound declarations
 * can be collected. Does not touch persisted approval; use
 * {@link revokeExtensionApproval} for that.
 */
export function evictBlockFromCache(
  blockId: string,
  cache: CompileCache = defaultCache,
): void {
  cache.byBlockAndHash.delete(blockId)
  cache.unpersistedUpgrades.delete(blockId)
}
