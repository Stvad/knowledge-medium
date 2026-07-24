/** Load the live program config: engine knobs from the settings block,
 *  program content parsed from the plan outline.
 *
 *  The plan outline is canonical and human-editable — this reads it, never
 *  writes it. Reading it live (rather than snapshotting into a config block)
 *  is what makes "edit the program by editing your notes" literally true: a
 *  changed rep range or re-entry percentage takes effect on the next
 *  prescription. If the plan can't be found or a line can't be read, the
 *  built-in plan-faithful defaults fill the gap and the reason surfaces as a
 *  warning rather than a silent hole.
 */

import type {BlockData, PropertySchema} from '@/data/api/index.js'
import type {Repo} from '@/data/repo.js'

import type {ProgramConfig} from '../engine/types'
import {DEFAULT_CONFIG} from '../program/defaults'
import {configFromPlan, type PlanNode} from '../program/planParser'
import {
  cadenceDaysProp,
  planRootProp,
  rolloverHourProp,
  roundToProp,
} from './schema'

/** The Strength Plan v2 outline root from the handoff. A default only —
 *  overridable via the settings block's `plan-root`, and resolvable by the
 *  "Strength Plan v2" alias when neither points anywhere live. */
export const DEFAULT_PLAN_ROOT_ID = 'ed2e8053-ea55-4130-9207-01409192a4aa'
export const PLAN_ALIAS = 'Strength Plan v2'
/** Shoulder-policy block referenced by auto-created consult todos. */
export const SHOULDER_POLICY_BLOCK_ID = '3f8866f6-7143-4bbe-b9a0-fa60abf12be5'

const read = <T>(block: BlockData | null, schema: PropertySchema<T>): T => {
  const raw = block?.properties[schema.name]
  return raw === undefined || raw === null ? schema.defaultValue : schema.codec.decode(raw)
}

/** Load the outline under `rootId` into the parser's `PlanNode` shape. */
const loadPlanTree = async (repo: Repo, rootId: string): Promise<PlanNode | null> => {
  const root = await repo.block(rootId).load()
  if (!root || root.deleted) return null
  const build = async (block: BlockData): Promise<PlanNode> => {
    const childData = await repo.block(block.id).children.load()
    const children = await Promise.all((childData ?? []).filter(c => !c.deleted).map(build))
    return {id: block.id, content: block.content, children}
  }
  return build(root)
}

const resolvePlanRoot = async (
  repo: Repo,
  workspaceId: string,
  settings: BlockData | null,
): Promise<string | null> => {
  const configured = read(settings, planRootProp)
  const candidates = [configured, DEFAULT_PLAN_ROOT_ID].filter(id => id.length > 0)
  for (const id of candidates) {
    const block = await repo.block(id).load()
    if (block && !block.deleted) return id
  }
  const aliased = await repo.runQuery<{id: string} | null>('core.aliasLookup', {
    alias: PLAN_ALIAS,
    workspaceId,
  }).catch(() => null)
  return aliased?.id ?? null
}

export interface LoadedConfig {
  config: ProgramConfig
  warnings: readonly string[]
  planRootId: string | null
}

/** Merge engine-knob overrides from the settings block into a base config. */
const applySettings = (base: ProgramConfig, settings: BlockData | null): ProgramConfig => ({
  ...base,
  roundTo: read(settings, roundToProp),
  dayRolloverHour: read(settings, rolloverHourProp),
  perLiftCadenceDays: read(settings, cadenceDaysProp),
})

export const loadConfig = async (
  repo: Repo,
  workspaceId: string,
  settingsBlockId: string | null,
): Promise<LoadedConfig> => {
  const settings = settingsBlockId ? await repo.block(settingsBlockId).load() : null
  const base = applySettings(DEFAULT_CONFIG, settings)

  const planRootId = await resolvePlanRoot(repo, workspaceId, settings)
  if (!planRootId) {
    return {
      config: base,
      warnings: ['Strength Plan v2 outline not found — using the built-in program. Set the plan-root in strength settings to read from your notes.'],
      planRootId: null,
    }
  }

  const tree = await loadPlanTree(repo, planRootId)
  if (!tree) {
    return {config: base, warnings: ['Plan outline could not be read — using the built-in program.'], planRootId}
  }

  const {config, warnings} = configFromPlan(tree)
  // The plan supplies program content; the settings block supplies engine
  // knobs. Re-apply the knobs so a settings override wins over the default.
  return {config: applySettings(config, settings), warnings, planRootId}
}
