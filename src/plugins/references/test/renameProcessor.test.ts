// @vitest-environment node
/**
 * Integration tests for the references.renameBacklinks post-commit
 * processor (cases R1, R4, R7 + the A2-cascade in
 * docs/alias-rename-cases.html). Drives the full pipeline through
 * `repo.tx` so the field-watcher fires; the alias plugin's sync
 * processor also runs, since composition (sync writes a swap, rename
 * acts on it) is part of the spec.
 *
 * Source-rewrite shapes:
 *   - R1 (1-for-1 swap):           `[[α]] → [[new]]`
 *   - R4/R7 (anything else):       `[[α]] → [α](((target-id)))`
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { aliasesProp } from '@/data/internals/coreProperties'
import { dailyNotesDataExtension } from '@/plugins/daily-notes'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { kernelDataExtension } from '@/data/kernelDataExtension.ts'
import { aliasDataExtension } from '@/plugins/alias/dataExtension.ts'
import { referencesDataExtension } from '../dataExtension.ts'

interface Harness {
  h: TestDb
  cache: BlockCache
  repo: Repo
  read(id: string): Promise<{id: string; content: string; deleted: 0 | 1; properties_json: string} | null>
}

const setup = async (): Promise<Harness> => {
  const h = await createTestDb()
  const cache = new BlockCache()
  let timeCursor = 1700_000_000_000
  let idCursor = 0
  const repo = new Repo({
    db: h.db,
    cache,
    user: {id: 'user-1'},
    now: () => ++timeCursor,
    newId: () => `gen-${++idCursor}`,
    registerKernelProcessors: false,
  })
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    dailyNotesDataExtension,
    referencesDataExtension,
    aliasDataExtension,
  ]))
  return {
    h,
    cache,
    repo,
    read: async id => h.db.getOptional(
      `SELECT id, content, deleted, properties_json FROM blocks WHERE id = ?`,
      [id],
    ),
  }
}

let env: Harness
beforeEach(async () => {
  env = await setup()
  vi.useFakeTimers({shouldAdvanceTime: true})
})
afterEach(async () => {
  vi.useRealTimers()
  await env.h.cleanup()
})

const WS = 'ws-1'

const flush = async () => {
  await vi.advanceTimersByTimeAsync(1)
  await env.repo.awaitProcessors()
}

const seedTarget = async (
  id: string,
  content: string,
  aliases: readonly string[],
): Promise<void> => {
  await env.repo.tx(async tx => {
    await tx.create({id, workspaceId: WS, parentId: null, orderKey: 'a0', content})
    await tx.setProperty(id, aliasesProp, [...aliases])
  }, {scope: ChangeScope.BlockDefault})
  await flush()
}

const seedSource = async (id: string, content: string): Promise<void> => {
  await env.repo.tx(
    tx => tx.create({id, workspaceId: WS, parentId: null, orderKey: 'b0', content}),
    {scope: ChangeScope.BlockDefault},
  )
  await flush()
}

describe('rename — Case R1 (clean 1-for-1 swap)', () => {
  it('rewrites [[Old]] → [[New]] in source content', async () => {
    await seedTarget('t', 'Old', ['Old'])
    await seedSource('s', 'See [[Old]] for context.')

    await env.repo.tx(
      tx => tx.setProperty('t', aliasesProp, ['New']),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    expect((await env.read('s'))!.content).toBe('See [[New]] for context.')
  })

  it('does not rewrite blocks that did not reference the alias', async () => {
    await seedTarget('t', 'Old', ['Old'])
    await seedSource('s', 'See [[Old]] for context.')
    await seedSource('other', 'unrelated body')

    await env.repo.tx(
      tx => tx.setProperty('t', aliasesProp, ['New']),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    expect((await env.read('other'))!.content).toBe('unrelated body')
  })
})

describe('rename — Case R4 (pure remove, some aliases remain)', () => {
  it('rewrites [[B]] → [B](((target-id))) on source content', async () => {
    await seedTarget('t', '', ['A', 'B'])
    await seedSource('s', 'see [[B]] please')

    await env.repo.tx(
      tx => tx.setProperty('t', aliasesProp, ['A']),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    expect((await env.read('s'))!.content).toBe('see [B](((t))) please')
  })
})

describe('rename — Case R7 (remove last alias)', () => {
  it('rewrites [[A]] → [A](((target-id))) (only blockref form preserves the link)', async () => {
    await seedTarget('t', '', ['A'])
    await seedSource('s', 'see [[A]] please')

    await env.repo.tx(
      tx => tx.setProperty('t', aliasesProp, []),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    expect((await env.read('s'))!.content).toBe('see [A](((t))) please')
  })
})

describe('rename — composition with sync (A2-cascade hits R4)', () => {
  it('content edit collapses an alias and rewrites source backlinks to blockref form', async () => {
    // Target before: content "X", aliases ["X","Y"]. User edits
    // content to "Y" — sync rule 1 fires: replace "X" with "Y" in
    // aliases, dedupe → ["Y"]. The cascading alias-swap is a pure
    // remove of "X" (Case A2 cascade → R4); rename rewrites [[X]] to
    // [X](((target-id))) in source backlinks.
    await seedTarget('t', 'X', ['X', 'Y'])
    await seedSource('s', 'see [[X]] please')

    await env.repo.mutate.setContent({id: 't', content: 'Y'})
    await flush()

    expect((await env.read('t'))!.content).toBe('Y')
    expect(JSON.parse((await env.read('t'))!.properties_json).alias).toEqual(['Y'])
    expect((await env.read('s'))!.content).toBe('see [X](((t))) please')
  })
})

describe('rename — Case R3 (pure add) and deletes', () => {
  it('pure add does not touch source content', async () => {
    await seedTarget('t', '', ['A'])
    await seedSource('s', 'see [[A]] please')

    await env.repo.tx(
      tx => tx.setProperty('t', aliasesProp, ['A', 'B']),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    expect((await env.read('s'))!.content).toBe('see [[A]] please')
  })

  it('soft-deleted target does not trigger rewrites', async () => {
    await seedTarget('t', '', ['A'])
    await seedSource('s', 'see [[A]] please')

    await env.repo.tx(tx => tx.delete('t'), {scope: ChangeScope.BlockDefault})
    await flush()

    expect((await env.read('s'))!.content).toBe('see [[A]] please')
  })
})

describe('rename — convergence', () => {
  it('rewriting source content does not cause rename to re-fire', async () => {
    await seedTarget('t', 'Old', ['Old'])
    await seedSource('s', 'See [[Old]] today.')

    await env.repo.tx(
      tx => tx.setProperty('t', aliasesProp, ['New']),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    const afterFirst = (await env.read('s'))!.content
    // No new alias edits; nothing for rename to do on a second flush.
    await flush()
    expect((await env.read('s'))!.content).toBe(afterFirst)
  })
})

describe('rename — multi-source', () => {
  it('rewrites all sources that reference the renamed alias', async () => {
    await seedTarget('t', 'Old', ['Old'])
    await seedSource('s1', 'one [[Old]] here')
    await seedSource('s2', 'two [[Old]] there')
    await seedSource('s3', 'three [[Old]] and [[Old]] again')

    await env.repo.tx(
      tx => tx.setProperty('t', aliasesProp, ['New']),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    expect((await env.read('s1'))!.content).toBe('one [[New]] here')
    expect((await env.read('s2'))!.content).toBe('two [[New]] there')
    expect((await env.read('s3'))!.content).toBe('three [[New]] and [[New]] again')
  })
})

describe('rename — parser-aware rewrite (regressions)', () => {
  it('rewrites a trimmed `[[ Old ]]` form (parser trims, processor must too)', async () => {
    // parseReferences trims inside `[[ ... ]]` and indexes the trimmed
    // alias into block_references. The rewrite must find it too.
    await seedTarget('t', 'Old', ['Old'])
    await seedSource('s', 'see [[ Old ]] please')

    await env.repo.tx(
      tx => tx.setProperty('t', aliasesProp, ['New']),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    expect((await env.read('s'))!.content).toBe('see [[New]] please')
  })

  it('handles aliases containing `$&` without regex backreference corruption', async () => {
    // String.replace(pattern, replacement) interprets `$&`/`$1` in the
    // replacement; aliases or new names containing those would corrupt
    // output. Span-splicing avoids it.
    await seedTarget('t', 'X', ['$&'])
    await seedSource('s', 'see [[$&]] please')

    await env.repo.tx(
      tx => tx.setProperty('t', aliasesProp, ['$1-new']),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    expect((await env.read('s'))!.content).toBe('see [[$1-new]] please')
  })
})

describe('rename — stale-plan safety (concurrent source edit)', () => {
  // Helper: race a concurrent setContent into the gap between the
  // `block_references` SELECT (read phase) and the write tx. Returns
  // a teardown that restores the spy.
  const raceSourceEdit = (sourceId: string, nextContent: string) => {
    const originalGetAll = env.h.db.getAll.bind(env.h.db)
    let intercepted = false
    const spy = vi.spyOn(env.h.db, 'getAll').mockImplementation(async <T,>(
      sql: string,
      params?: unknown[],
    ): Promise<T[]> => {
      const rows = await originalGetAll<T>(sql, params)
      if (!intercepted && sql.includes('FROM block_references')) {
        intercepted = true
        await env.repo.mutate.setContent({id: sourceId, content: nextContent})
      }
      return rows
    })
    return {
      get intercepted() { return intercepted },
      restore: () => spy.mockRestore(),
    }
  }

  it('does not clobber a source edit that removed the wikilink', async () => {
    await seedTarget('t', 'Old', ['Old'])
    await seedSource('s', 'See [[Old]] for context.')

    const race = raceSourceEdit('s', 'See nothing for context.')
    try {
      await env.repo.tx(
        tx => tx.setProperty('t', aliasesProp, ['New']),
        {scope: ChangeScope.BlockDefault},
      )
      await flush()
      // Content diverged from read-time snapshot → rewrite skipped.
      expect(race.intercepted).toBe(true)
      expect((await env.read('s'))!.content).toBe('See nothing for context.')
    } finally {
      race.restore()
    }
  })

  it('does not rewrite [[Old]] spans the user typed after the read phase', async () => {
    // Race in an edit that ADDS another `[[Old]]` to source. With a
    // naive rewrite-all approach the new span would also be rewritten
    // to `[[New]]`, even though it didn't exist at decision time. The
    // strict divergence skip leaves the source alone.
    await seedTarget('t', 'Old', ['Old'])
    await seedSource('s', 'See [[Old]] for context.')

    const race = raceSourceEdit(
      's',
      'See [[Old]] for context. Also [[Old]] here.',
    )
    try {
      await env.repo.tx(
        tx => tx.setProperty('t', aliasesProp, ['New']),
        {scope: ChangeScope.BlockDefault},
      )
      await flush()
      expect(race.intercepted).toBe(true)
      expect((await env.read('s'))!.content).toBe(
        'See [[Old]] for context. Also [[Old]] here.',
      )
    } finally {
      race.restore()
    }
  })
})

describe('rename — rapid title edits cascade fully', () => {
  it('source backlinks resolve to the final target alias after rapid edits', async () => {
    // Two rapid title renames. Without inline references updates, the
    // second rename's `block_references` SELECT can run before
    // parseReferences has reparsed the source rewritten by the first
    // rename — the index would still say alias="Old", and the lookup
    // for alias="New name" returns empty, leaving the source stuck at
    // `[[New name]]` (which no longer resolves to the target, whose
    // aliases are now ["Brand new"]). Regression test for that race.
    await seedTarget('t', 'Old', ['Old'])
    await seedSource('s', 'See [[Old]] for context.')

    await env.repo.mutate.setContent({id: 't', content: 'New name'})
    await env.repo.mutate.setContent({id: 't', content: 'Brand new'})
    await flush()

    expect((await env.read('t'))!.content).toBe('Brand new')
    expect(
      JSON.parse((await env.read('t'))!.properties_json).alias,
    ).toEqual(['Brand new'])
    // Backlink must point to a live alias of the target. `[[New name]]`
    // would be broken (target has no such alias); `[[Old]]` would mean
    // the original rename didn't cascade at all.
    expect((await env.read('s'))!.content).toBe('See [[Brand new]] for context.')
  })
})

describe('rename — replacement form roundtrip safety', () => {
  // Aliased blockrefs only parse for UUID-shaped target ids (the
  // grammar pins the id segment to that). Use a real UUID here so
  // the rewritten content roundtrips through parseReferences and the
  // backlink survives all the way into `block_references`.
  const TARGET_UUID = '11111111-2222-4333-8444-555555555555'

  const blockReferences = async (sourceId: string, targetId: string) =>
    env.h.db.getAll<{alias: string; source_field: string}>(
      `SELECT alias, source_field FROM block_references
       WHERE source_id = ? AND target_id = ?
       ORDER BY alias, source_field`,
      [sourceId, targetId],
    )

  it('falls back to blockref form when the added alias is blank', async () => {
    // `renderWikilink('')` = `[[]]`, which parseReferences ignores —
    // emitting it would silently drop the backlink. Use blockref form.
    await seedTarget(TARGET_UUID, 'X', ['Old'])
    await seedSource('s', 'see [[Old]] please')

    await env.repo.tx(
      tx => tx.setProperty(TARGET_UUID, aliasesProp, ['']),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    expect((await env.read('s'))!.content).toBe(
      `see [Old](((${TARGET_UUID}))) please`,
    )
    // Backlink must actually resolve: parseReferences re-parses the
    // rewritten content, the aliased blockref pins to TARGET_UUID,
    // and the trigger-maintained `block_references` row carries
    // alias=TARGET_UUID (the blockref convention — alias === id).
    expect(await blockReferences('s', TARGET_UUID)).toEqual([
      {alias: TARGET_UUID, source_field: ''},
    ])
  })

  it('falls back to blockref form when the added alias does not roundtrip', async () => {
    // `renderWikilink('foo]]bar')` collapses `]]` to `] ]`; the result
    // parses to `foo] ]bar`, not the original alias. Emitting it
    // would corrupt the backlink text. Blockref form preserves intent.
    await seedTarget(TARGET_UUID, 'X', ['Old'])
    await seedSource('s', 'see [[Old]] please')

    await env.repo.tx(
      tx => tx.setProperty(TARGET_UUID, aliasesProp, ['foo]]bar']),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    expect((await env.read('s'))!.content).toBe(
      `see [Old](((${TARGET_UUID}))) please`,
    )
    expect(await blockReferences('s', TARGET_UUID)).toEqual([
      {alias: TARGET_UUID, source_field: ''},
    ])
  })
})

