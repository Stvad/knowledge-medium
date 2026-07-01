import type React from 'react'
import type ReactDOM from 'react-dom'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import type { BlockData, SubtreeRow } from '@/data/api'
import type { FacetRuntime } from '@/facets/facet.js'
import type { blockRenderersFacet } from '@/extensions/core.js'
import type { ActionConfig } from '@/shortcuts/types.js'
import type { BlockProperties } from '@/types.js'
import type { refreshAppRuntime } from '@/facets/runtimeEvents.js'

export type SqlMode = 'all' | 'get' | 'optional' | 'execute'
export type BlockPosition = 'first' | 'last' | number

export interface AgentRuntimeCommand {
  commandId: string
  type: string
  [key: string]: unknown
}

export interface CreateBlockInput {
  parentId?: string
  position?: BlockPosition
  data?: Partial<BlockData>
  content?: string
  properties?: BlockProperties
}

export interface UpdateBlockInput {
  id: string
  content?: string
  properties?: BlockProperties
  replaceProperties?: boolean
}

export interface InstallExtensionInput {
  source: string
  label?: string
  /** Optional human-readable description shown in Extensions settings.
   *  Written to `extension:description` on the block. */
  description?: string
  parentId?: string
  id?: string
  reload?: boolean
  verify?: boolean
}

export interface ExtensionVerificationError {
  blockId: string
  message: string
  name?: string
}

export interface ExtensionLintWarning {
  rule: string
  message: string
  catalogPattern: string
  example?: string
}

export interface ExtensionVerificationResult {
  ok: boolean
  errors: ExtensionVerificationError[]
  actions: Array<{
    id: string
    description: string
    context: string
  }>
  facets: Array<{
    id: string
    contributionCount: number
  }>
  /** Ids of the facet contributions this specific extension owns —
   *  useful when an extension's verify lists facets/actions inherited
   *  from other extensions and the agent needs to confirm what this
   *  install actually added. Errors above include any structural
   *  problems found in these contributions (e.g. a renderer whose
   *  `renderer` field is not a function). */
  contributions: {
    renderers: string[]
    appMounts: string[]
    appEffects: string[]
  }
  /** Source-level lint warnings — anti-patterns the agent is likely
   *  to fall into when not reading the authoring catalog carefully
   *  (e.g. storing config in localStorage instead of a prefs block).
   *  Advisory, not blocking: `ok` reflects only structural errors. */
  warnings?: ExtensionLintWarning[]
}

export interface InstallExtensionResult {
  id: string
  inserted: boolean
  label: string | null
  reloaded?: boolean
  verification?: ExtensionVerificationResult
}

export interface SetExtensionEnabledInput {
  /** Extension block id. Either `id` or `label` is required. */
  id?: string
  /** Extension alias (the label passed at install time). */
  label?: string
  enabled: boolean
}

export interface SetExtensionEnabledResult {
  id: string
  label: string | null
  enabled: boolean
  /** Whether the override map actually changed. False when the extension
   *  was already in the requested state. */
  changed: boolean
}

export interface UninstallExtensionInput {
  /** Extension block id. Either `id` or `label` is required. */
  id?: string
  /** Extension alias (the label passed at install time). */
  label?: string
}

export interface UninstallExtensionResult {
  id: string
  label: string | null
  /** True when the block was newly soft-deleted by this call. False when
   *  the extension wasn't found or was already deleted. */
  removed: boolean
}

export interface AgentRuntimeContext {
  repo: Repo
  db: Repo['db']
  runtime: FacetRuntime
  safeMode: boolean
  sql: (sql: string, params?: unknown[], mode?: SqlMode) => Promise<unknown>
  block: (id: string) => Block
  getBlock: (id: string) => Promise<BlockData | null>
  getSubtree: (rootId: string) => Promise<SubtreeRow[]>
  createBlock: (input?: CreateBlockInput) => Promise<BlockData | null>
  updateBlock: (input: UpdateBlockInput) => Promise<BlockData | null>
  installExtension: (input: InstallExtensionInput) => Promise<InstallExtensionResult>
  setExtensionEnabled: (input: SetExtensionEnabledInput) => Promise<SetExtensionEnabledResult>
  uninstallExtension: (input: UninstallExtensionInput) => Promise<UninstallExtensionResult>
  actions: readonly ActionConfig[]
  renderers: ReturnType<typeof blockRenderersFacet.empty>
  refreshAppRuntime: typeof refreshAppRuntime
  React: typeof React
  ReactDOM: typeof ReactDOM
  window: Window
  document: Document
}

export interface AgentRuntimeBridgeOptions {
  repo: Repo
  runtime: FacetRuntime
  safeMode: boolean
}
