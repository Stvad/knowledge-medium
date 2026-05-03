import {
  compileExtensionModule,
  type CompileCache,
} from '@/extensions/compileExtensionModule.ts'
import {
  AppExtension,
  FacetContribution,
} from '@/extensions/facet.ts'
import { extensionDisabledProp } from '@/data/properties.ts'
import { Repo } from '../data/repo'
import { BlockData } from '@/types.ts'

export interface ExtensionLoadErrorReporter {
  (blockId: string, error: Error): void
}

export interface DynamicExtensionsOptions {
  repo: Repo
  workspaceId: string
  safeMode: boolean
  errorReporter?: ExtensionLoadErrorReporter
  // Optional override for tests. Production uses the module-wide
  // singleton in compileExtensionModule.ts.
  cache?: CompileCache
}

/**
 * Walks the workspace for blocks of `type: 'extension'`, compiles each,
 * and returns their default exports as a single AppExtension subtree.
 *
 * Block-author authorship contract:
 *   - The block is TS/JSX. It runs through Babel (react + typescript
 *     presets) and is loaded as an ESM module via blob URL.
 *   - `module.default` must be a valid AppExtension:
 *     a FacetContribution, an array of AppExtension, an async/sync
 *     function returning AppExtension, or nullish/false.
 *   - Imports work through the page-global importmap. `import { x }
 *     from '@/extensions/api.js'` returns the *same* module instance
 *     the running app uses, so contribution facets match by identity.
 *
 * Provenance: every contribution emitted from a block has its `source`
 * field force-prefixed with `block:<id>`. If the author supplied a
 * source, it becomes `block:<id>/<author-source>`. This makes the
 * agent-bridge `describeRuntime` payload show contribution origin
 * unambiguously.
 *
 * Failure isolation: a block whose source fails to compile or whose
 * default export is shaped wrong is reported via `errorReporter` and
 * skipped — other extensions still load.
 */
export const dynamicExtensionsExtension = (
  options: DynamicExtensionsOptions,
): AppExtension => async () => {
  const {repo, workspaceId, safeMode, errorReporter, cache} = options

  if (safeMode) {
    console.log('Safe mode enabled — skipping dynamic extension blocks')
    return []
  }

  let extensionBlocks: BlockData[]
  try {
    extensionBlocks = await repo.query.findExtensionBlocks({workspaceId}).load()
  } catch (error) {
    console.error('Failed to query extension blocks', error)
    return []
  }

  const collected: AppExtension[] = []

  for (const block of extensionBlocks) {
    if (block.properties[extensionDisabledProp.name] === true) continue

    try {
      const {module} = await compileExtensionModule(block.content, block.id, cache)
      const exported = module.default as AppExtension
      const validated = validateAndPrefix(exported, block.id)
      if (validated !== null) {
        collected.push(validated)
      }
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error))
      errorReporter?.(block.id, wrapped)
      console.error(`Failed to load extension block ${block.id}`, wrapped)
    }
  }

  return collected
}

const isFacetContribution = (value: unknown): value is FacetContribution<unknown> =>
  typeof value === 'object' &&
  value !== null &&
  (value as {type?: unknown}).type === 'facet-contribution'

/**
 * Walks an AppExtension tree, validates shape, and force-prefixes every
 * FacetContribution's `source`.
 *
 * Returns a normalized AppExtension on success; throws on shape errors so
 * the caller can attribute them to the offending block.
 */
const validateAndPrefix = (
  extension: AppExtension,
  blockId: string,
): AppExtension => {
  if (extension === null || extension === undefined || extension === false) {
    return null
  }

  if (Array.isArray(extension)) {
    return extension.map((child) => validateAndPrefix(child, blockId))
  }

  if (typeof extension === 'function') {
    // Wrap so the function's return value also gets prefixed.
    return async (context) => {
      const inner = await (extension as (
        ctx: typeof context,
      ) => AppExtension | Promise<AppExtension>)(context)
      return validateAndPrefix(inner, blockId)
    }
  }

  if (isFacetContribution(extension)) {
    return prefixContributionSource(extension, blockId)
  }

  throw new Error(
    `Extension default export has invalid shape: ${describeShape(extension)}. ` +
    `Expected a FacetContribution, an array of AppExtension, a function returning AppExtension, ` +
    `or null/undefined/false.`,
  )
}

const prefixContributionSource = (
  contribution: FacetContribution<unknown>,
  blockId: string,
): FacetContribution<unknown> => {
  const blockSource = `block:${blockId}`
  const composed = contribution.source
    ? `${blockSource}/${contribution.source}`
    : blockSource
  return {...contribution, source: composed}
}

const describeShape = (value: unknown): string => {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}
