import type React from 'react'
import type ReactDOM from 'react-dom'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import type { BlockData } from '@/data/api'
import type { FacetRuntime } from '@/extensions/facet.ts'
import type { blockRenderersFacet } from '@/extensions/core.ts'
import type { ActionConfig } from '@/shortcuts/types.ts'
import type { BlockProperties } from '@/types.ts'
import type { refreshAppRuntime } from '@/extensions/runtimeEvents.ts'

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
  parentId?: string
  id?: string
  disabled?: boolean
}

export interface InstallExtensionResult {
  id: string
  inserted: boolean
  label: string | null
}

export interface AgentRuntimeContext {
  repo: Repo
  db: Repo['db']
  runtime: FacetRuntime
  safeMode: boolean
  sql: (sql: string, params?: unknown[], mode?: SqlMode) => Promise<unknown>
  block: (id: string) => Block
  getBlock: (id: string) => Promise<BlockData | null>
  getSubtree: (rootId: string) => Promise<BlockData[]>
  createBlock: (input?: CreateBlockInput) => Promise<BlockData | null>
  updateBlock: (input: UpdateBlockInput) => Promise<BlockData | null>
  installExtension: (input: InstallExtensionInput) => Promise<InstallExtensionResult>
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
