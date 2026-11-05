// @vitest-environment node
/**
 * Fuzz suite for `buildGroupedBacklinks` (`../grouping.ts`), the pure fold
 * from (backlink source, candidate group) pairs to the sections the linked
 * references panel renders. See `src/test/fuzz.ts` for smoke/deep tier
 * mechanics and `docs/fuzzing.md` for conventions. Pure and synchronous.
 *
 * Invariants, none of which reads the implementation's intermediate state:
 *  - nothing is lost: every source is shown, and a source outside every field
 *    group is shown exactly once;
 *  - a source in a field group is in no other kind of group (field groups may
 *    overlap each other) and not in the fallback;
 *  - every member is backed by a candidate naming that source and that group,
 *    never the target and never a group whose label the config excludes;
 *  - group ids are unique, members keep `sourceOrder` order, the fallback is
 *    last and only present when non-empty;
 *  - sizes: a non-field group below `minGroupSize` exists only at high
 *    priority, and a source with a surviving high-priority candidate never
 *    falls through to the fallback;
 *  - maximality: what reaches the fallback could not have formed a group —
 *    no surviving default/low candidate group holds `minGroupSize` of it.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  buildGroupedBacklinks,
  FALLBACK_GROUP_ID,
  type GroupedBacklinkCandidate,
} from '../grouping.ts'
import type { GroupedBacklinksConfig } from '../config.ts'
import { fuzzParams } from '@/test/fuzz'

const TARGET = 'target'
const SOURCES = ['s0', 's1', 's2', 's3', 's4', 's5', 's6']
/** Field and type group ids are always prefixed (`query.ts` builds them). */
const SYNTHETIC_GROUP_IDS = ['field:f', 'field:g', 'type:t']
/** A block id can be anything sync delivers: the target itself, a synthetic
 *  group's id, or the fallback's. */
const BLOCK_GROUP_IDS = ['g0', 'g1', 'g2', 'g3', TARGET, ...SYNTHETIC_GROUP_IDS, FALLBACK_GROUP_ID]
const LABELS = ['Alpha', 'Beta', 'Gamma', 'Xeno', ' ', '']

const candidateArb: fc.Arbitrary<GroupedBacklinkCandidate> = fc.oneof(
  fc.record({
    kind: fc.constantFrom<GroupedBacklinkCandidate['kind']>('ref', 'root', 'attribute'),
    groupId: fc.constantFrom(...BLOCK_GROUP_IDS),
  }),
  fc.record({
    kind: fc.constant<GroupedBacklinkCandidate['kind']>('field'),
    groupId: fc.constantFrom('field:f', 'field:g'),
  }),
  fc.record({
    kind: fc.constant<GroupedBacklinkCandidate['kind']>('type'),
    groupId: fc.constant('type:t'),
  }),
).chain(({kind, groupId}) => fc.record({
  sourceId: fc.constantFrom(...SOURCES, 'not-a-source'),
  groupId: fc.constant(groupId),
  groupLabel: fc.constantFrom(...LABELS),
  kind: fc.constant(kind),
}))

const tagsArb = fc.subarray(['Alpha', 'Beta', 'Gamma', 'Xeno', ' Beta '])
const configArb: fc.Arbitrary<GroupedBacklinksConfig> = fc.record({
  highPriorityTags: tagsArb,
  lowPriorityTags: tagsArb,
  excludedTags: tagsArb,
  // `[` does not compile and must be ignored rather than throw.
  excludedPatterns: fc.subarray(['^X', '[', 'mm']),
})

const caseArb = fc.record({
  sourceOrder: fc.shuffledSubarray(SOURCES),
  candidates: fc.array(candidateArb, {maxLength: 30}),
  config: configArb,
  minGroupSize: fc.integer({min: 1, max: 3}),
})

const isBlockKind = (kind: GroupedBacklinkCandidate['kind']) =>
  kind === 'ref' || kind === 'root' || kind === 'attribute'

const trimmedSet = (values: readonly string[]) =>
  new Set(values.map(v => v.trim()).filter(Boolean))

/** The candidates the spec lets through, read off the inputs alone. */
const surviving = (
  {sourceOrder, candidates, config}: {
    sourceOrder: readonly string[]
    candidates: readonly GroupedBacklinkCandidate[]
    config: GroupedBacklinksConfig
  },
) => {
  const sources = new Set(sourceOrder)
  const synthetic = new Set([FALLBACK_GROUP_ID, ...candidates.filter(c => !isBlockKind(c.kind)).map(c => c.groupId)])
  const excludedTags = trimmedSet(config.excludedTags)
  const patterns = config.excludedPatterns.flatMap(p => {
    try { return [new RegExp(p)] } catch { return [] }
  })
  const excluded = (label: string) =>
    label.trim() === '' || excludedTags.has(label) || patterns.some(p => p.test(label))
  return candidates.filter(c =>
    c.groupId !== TARGET
    && sources.has(c.sourceId)
    && !(isBlockKind(c.kind) && synthetic.has(c.groupId))
    && !excluded(c.groupLabel))
}

describe('buildGroupedBacklinks (fuzz)', () => {
  it('shows every source, once outside field groups, each under a group that names it', () => {
    fc.assert(
      fc.property(caseArb, input => {
        const groups = buildGroupedBacklinks({
          targetId: TARGET,
          sourceOrder: input.sourceOrder,
          candidates: input.candidates,
          groupingConfig: input.config,
          minGroupSize: input.minGroupSize,
        })
        const live = surviving(input)
        const kindOf = new Map<string, GroupedBacklinkCandidate['kind']>()
        for (const c of live) if (!kindOf.has(c.groupId)) kindOf.set(c.groupId, c.kind)
        const isField = (groupId: string) => kindOf.get(groupId) === 'field'

        expect(new Set(groups.map(g => g.groupId)).size).toBe(groups.length)

        const position = new Map(input.sourceOrder.map((id, i) => [id, i]))
        const inField = new Set<string>()
        const outsideField = new Map<string, number>()
        for (const [i, group] of groups.entries()) {
          expect(group.sourceIds.length).toBeGreaterThan(0)
          const indices = group.sourceIds.map(id => position.get(id)!)
          expect(indices).toEqual([...indices].sort((a, b) => a - b))
          expect(new Set(group.sourceIds).size).toBe(group.sourceIds.length)

          if (group.fallback) {
            expect(group.groupId).toBe(FALLBACK_GROUP_ID)
            expect(i).toBe(groups.length - 1)
          } else {
            expect(group.groupId).not.toBe(TARGET)
            for (const id of group.sourceIds) {
              expect(live.some(c => c.sourceId === id && c.groupId === group.groupId)).toBe(true)
            }
            expect(group.blockId).toBe(isBlockKind(kindOf.get(group.groupId)!) ? group.groupId : null)
          }

          for (const id of group.sourceIds) {
            if (!group.fallback && isField(group.groupId)) inField.add(id)
            else outsideField.set(id, (outsideField.get(id) ?? 0) + 1)
          }
        }

        for (const id of input.sourceOrder) {
          if (inField.has(id)) expect(outsideField.has(id)).toBe(false)
          else expect(outsideField.get(id)).toBe(1)
        }
      }),
      fuzzParams(400),
    )
  })

  it('emits small groups only at high priority, and leaves nothing groupable in the fallback', () => {
    fc.assert(
      fc.property(caseArb, input => {
        const groups = buildGroupedBacklinks({
          targetId: TARGET,
          sourceOrder: input.sourceOrder,
          candidates: input.candidates,
          groupingConfig: input.config,
          minGroupSize: input.minGroupSize,
        })
        const live = surviving(input)
        const high = trimmedSet(input.config.highPriorityTags)
        const isHigh = (groupId: string) =>
          live.some(c => c.groupId === groupId && high.has(c.groupLabel))
        const fieldIds = new Set(live.filter(c => c.kind === 'field').map(c => c.groupId))

        for (const group of groups) {
          if (group.fallback || fieldIds.has(group.groupId)) continue
          if (group.sourceIds.length < input.minGroupSize) expect(isHigh(group.groupId)).toBe(true)
        }

        const fallback = new Set(groups.find(g => g.fallback)?.sourceIds ?? [])
        for (const c of live) {
          if (c.kind === 'field') continue
          if (high.has(c.groupLabel)) expect(fallback.has(c.sourceId)).toBe(false)
        }

        // A group is high when any of its candidates is; default and low
        // groups are the ones `minGroupSize` gates.
        const groupIds = new Set(live.filter(c => c.kind !== 'field').map(c => c.groupId))
        for (const groupId of groupIds) {
          if (isHigh(groupId)) continue
          const members = new Set(live.filter(c => c.groupId === groupId).map(c => c.sourceId))
          const stranded = [...members].filter(id => fallback.has(id))
          expect(stranded.length).toBeLessThan(input.minGroupSize)
        }
      }),
      fuzzParams(400),
    )
  })
})
