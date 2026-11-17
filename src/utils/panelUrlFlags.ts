import type {BlockData, PropertySchema, Tx} from '@/data/api'
import type {Repo} from '@/data/repo'
import {peekRowProperty} from '@/data/rowProperty'
import {defineFacet} from '@/facets/facet'
import {RESERVED_SLOT_CONTEXT_KEYS} from '@/utils/routing'

export interface PanelUrlFlag {
  readonly key: string
  readonly property: PropertySchema<boolean>
}

const reservedKeys = new Set(RESERVED_SLOT_CONTEXT_KEYS)
const validKey = (key: string): boolean =>
  /^[a-z][a-z0-9-]*$/.test(key) && !reservedKeys.has(key)

/** Each ordinary URL flag maps to one boolean property; absent means off. */
export const panelUrlFlagsFacet = defineFacet<PanelUrlFlag>({
  id: 'panel-url-flags',
  validate: (value): value is PanelUrlFlag =>
    typeof value === 'object' && value !== null &&
    'key' in value && typeof value.key === 'string' && validKey(value.key) &&
    'property' in value && typeof value.property === 'object' && value.property !== null,
  combine: values => {
    const flags = new Map<string, PanelUrlFlag>()
    for (const flag of values) flags.set(flag.key, flag)
    return [...flags.values()]
  },
  empty: () => [],
})

export const panelUrlFlags = (repo: Pick<Repo, 'facetRuntime'>): readonly PanelUrlFlag[] =>
  repo.facetRuntime?.read(panelUrlFlagsFacet) ?? []

export const panelUrlFlagEnabled = (rest: readonly string[] | undefined, key: string): boolean =>
  rest?.some(part => part === key || part === `${key}=true`) ?? false

export const panelUrlFlagsFromRow = (
  row: Pick<BlockData, 'properties'>,
  flags: readonly PanelUrlFlag[],
): string[] => flags
  .filter(({property}) => peekRowProperty(row, property) === true)
  .map(({key}) => key)
  .sort()

export const samePanelUrlFlags = (
  leftRest: readonly string[] | undefined,
  rightRest: readonly string[] | undefined,
  flags: readonly PanelUrlFlag[],
): boolean => flags.every(({key}) =>
  panelUrlFlagEnabled(leftRest, key) === panelUrlFlagEnabled(rightRest, key),
)

export const applyPanelUrlFlags = async (
  tx: Tx,
  row: BlockData,
  targetRest: readonly string[] | undefined,
  flags: readonly PanelUrlFlag[],
): Promise<boolean> => {
  let changed = false
  for (const {key, property} of flags) {
    const enabled = panelUrlFlagEnabled(targetRest, key)
    if ((peekRowProperty(row, property) === true) === enabled) continue
    await tx.setProperty(row.id, property, enabled)
    changed = true
  }
  return changed
}
