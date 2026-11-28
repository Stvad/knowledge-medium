import {hex} from '@scure/base'
import type {CompiledRecord} from './compiledModuleCache.js'
import type {ExtensionImportManifest} from './extensionImportPolicy.js'
import {transpileExtension} from './transpileExtension.js'

// Bump when a compiler change invalidates cached output.
// v2: Inline source maps and a per-block sourceURL.
// v3: Automatic React JSX runtime.
// v4: Preserve uninitialized class fields under Babel 8.
// v5: Validate compiled imports and link dependencies by integrity.
export const COMPILER_VERSION = '5'

/** The approval pins the source hash independently of the compiler version. */
export async function hashExtensionSource(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  return hex.encode(new Uint8Array(digest))
}

export class VendoredImportError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Could not vendor extension import', {cause})
  }
}

interface ApprovalOptions {
  allowUnpinnedLive: boolean
  manifest?: ExtensionImportManifest
  frozen?: CompiledRecord['vendored'] | ((integrity: string) => Promise<Uint8Array<ArrayBuffer> | undefined>)
}

type Transpile = (...args: Parameters<typeof transpileExtension>) => Promise<
  Pick<CompiledRecord, 'compiled' | 'importsUnpinned' | 'hasStaticUnpinnedImports'>
  & {pinnedImports: ReadonlyMap<string, string>}
>

export async function buildApprovalRecord(
  blockId: string, source: string, {frozen, allowUnpinnedLive, manifest}: ApprovalOptions,
  transpile: Transpile = transpileExtension,
): Promise<CompiledRecord> {
  const {pinnedImports: pins, ...output} = await transpile(source, blockId, allowUnpinnedLive, manifest)
  const record: CompiledRecord = {
    ...output,
    sourceHash: await hashExtensionSource(source),
    approvedSource: source,
    compilerVersion: COMPILER_VERSION,
    approvedAt: Date.now(),
  }
  for (const [url, integrity] of pins) {
    try {
      const {vendorModule} = await import('@knowledge-medium/agent-cli/freezeExtensionImports')
      const stored = record.vendored?.[integrity] ?? (
        typeof frozen === 'function' ? await frozen(integrity) : frozen?.[integrity]
      )
      const {bytes} = await vendorModule(url, integrity, stored)
      record.vendored ??= {}
      record.vendored[integrity] = bytes
    } catch (cause) {
      throw new VendoredImportError(cause)
    }
  }
  return record
}
