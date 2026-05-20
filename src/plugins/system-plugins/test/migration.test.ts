/**
 * Pure migration-shape tests. The real `runLegacyDisableMigration`
 * wraps this with Repo + tx plumbing, which is integration-tested
 * separately. The merge logic here is what determines correctness:
 *
 *   - new entries are added for every legacy-disabled block
 *   - pre-existing overrides survive (e.g. a user-toggled system
 *     plugin keeps its `false` after migration)
 *   - no entries → no work + identity-preserving output (so the
 *     idempotent no-op path is cheap)
 */
import {describe, expect, it} from 'vitest'
import {makeBlockData} from '@/data/test/factories.ts'
import {extensionDisabledProp} from '@/data/properties.ts'
import {computeLegacyDisableMigration} from '@/plugins/system-plugins/migration.ts'
import type {Overrides} from '@/extensions/togglable.ts'

const block = (id: string, disabled?: boolean) =>
  makeBlockData({
    id,
    workspaceId: 'ws',
    properties: disabled === undefined
      ? {}
      : {[extensionDisabledProp.name]: disabled},
  })

describe('computeLegacyDisableMigration', () => {
  it('adds a `false` entry to overrides for every legacy-disabled block', () => {
    const result = computeLegacyDisableMigration({
      extensionBlocks: [
        block('a', true),
        block('b', true),
        block('c', false),
        block('d'),
      ],
      currentOverrides: new Map(),
    })

    expect(Array.from(result.nextOverrides.entries()).sort()).toEqual([
      ['a', false],
      ['b', false],
    ])
    expect(result.blocksToClear.map(b => b.id).sort()).toEqual(['a', 'b'])
  })

  it('preserves existing overrides entries when adding new ones', () => {
    const existing: Overrides = new Map([
      ['system:vim', false],
      ['user-ext-1', true], // unusual but legal
    ])
    const result = computeLegacyDisableMigration({
      extensionBlocks: [block('legacy', true)],
      currentOverrides: existing,
    })

    expect(result.nextOverrides.get('system:vim')).toBe(false)
    expect(result.nextOverrides.get('user-ext-1')).toBe(true)
    expect(result.nextOverrides.get('legacy')).toBe(false)
  })

  it('returns the same overrides reference when nothing to migrate (cheap no-op)', () => {
    const existing: Overrides = new Map([['system:vim', false]])
    const result = computeLegacyDisableMigration({
      extensionBlocks: [block('still-on', false), block('never-flagged')],
      currentOverrides: existing,
    })

    expect(result.nextOverrides).toBe(existing)
    expect(result.blocksToClear).toEqual([])
  })

  it('overwrites stale "enabled" override when block has legacy disable flag', () => {
    // Edge case: somebody had an explicit `true` override for a block
    // that also still carries the legacy disabled prop. Migration
    // resolves the conflict in favour of the legacy state because
    // that's the input we're translating from.
    const existing: Overrides = new Map([['conflicted', true]])
    const result = computeLegacyDisableMigration({
      extensionBlocks: [block('conflicted', true)],
      currentOverrides: existing,
    })

    expect(result.nextOverrides.get('conflicted')).toBe(false)
  })

  it('does not add entries for blocks lacking the legacy property', () => {
    const result = computeLegacyDisableMigration({
      extensionBlocks: [block('plain'), block('explicit-false', false)],
      currentOverrides: new Map(),
    })

    expect(result.nextOverrides.size).toBe(0)
    expect(result.blocksToClear).toEqual([])
  })
})
