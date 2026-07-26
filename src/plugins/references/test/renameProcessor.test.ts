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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { aliasesProp } from '@/data/properties'
import { dailyNotesDataExtension } from '@/plugins/daily-notes'
import { aliasDataExtension } from '@/plugins/alias/dataExtension.js'
import { aliasSeatSeed, computeAliasSeatId, ensureAliasTarget } from '@/data/targets'
import { propertyDefinitionBlockId } from '@/data/definitionSeeds'
import { referencesDataExtension } from '../dataExtension.ts'
import {
  applyRefRewrites,
  hasDeepUserContent,
  isWindowMintedAliasSeat,
  RENAME_BACKLINKS_PROCESSOR,
  seatClassificationCtx,
  type Rewrite,
  type SeatCandidateRow,
} from '../renameProcessor.ts'

interface Harness {
  h: TestDb
  cache: BlockCache
  repo: Repo
  read(id: string): Promise<{id: string; content: string; deleted: 0 | 1; properties_json: string; references_json: string} | null>
}

const setup = async (): Promise<Harness> => {
  // Shared DB opened once per file (beforeAll), reset here per test.
  await resetTestDb(sharedDb.db)
  const { repo, cache } = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    extensions: [
      dailyNotesDataExtension,
      referencesDataExtension,
      aliasDataExtension,
    ],
  })
  // Property child-backing is workspace-scoped and reads the ACTIVE
  // workspace, so the flipped-workspace case below is a no-op without
  // this (and the seat would silently have no generated children).
  repo.setActiveWorkspaceId(WS)
  // h.cleanup disposes this Repo's observer (not the shared DB).
  const h: TestDb = {db: sharedDb.db, cleanup: async () => {}}
  return {
    h,
    cache,
    repo,
    read: async id => h.db.getOptional(
      `SELECT id, content, deleted, properties_json, references_json FROM blocks WHERE id = ?`,
      [id],
    ),
  }
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  env = await setup()
  vi.useFakeTimers({shouldAdvanceTime: true})
})
afterEach(async () => {
  vi.useRealTimers()
  await env.h.cleanup()
})

const WS = 'ws-1'

/** Target id for every case whose expected rewrite is the PINNED form
 *  `[label](((id)))`. The aliased-blockref grammar pins its id segment
 *  to a UUID shape, so a short test id like `'t'` renders a span that
 *  does not parse back as a reference at all — asserting it would pin
 *  a destroyed backlink rather than a preserved one. */
const PIN_TARGET = '11111111-2222-4333-8444-555555555555'

const flush = async () => {
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(1)
    await env.repo.awaitProcessors()
    await Promise.resolve()
  }
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

/** Content edges from `sourceId` to `targetId`, as the trigger-
 *  maintained projection sees them. */
const blockReferences = async (sourceId: string, targetId: string) =>
  env.h.db.getAll<{alias: string}>(
    `SELECT alias FROM block_references
     WHERE source_id = ? AND target_id = ? ORDER BY alias`,
    [sourceId, targetId],
  )

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

  // Regression (found by referencesRecompute.fuzz.test.ts): the rename
  // commit fires BOTH this processor and parseReferences. The parse plan
  // is built from pre-rewrite content, so without parseReferences'
  // stale-plan guard its write could land after the rename rewrite and
  // clobber the refs back to a seat for the REMOVED alias — content
  // `[[New]]` with a stored ref still carrying `Old`. A self-referencing
  // target makes the race deterministic-ish (one row, both processors).
  it('converges refs and content when the renamed target references itself', async () => {
    await seedTarget('t', 'see [[Old]]', ['Old'])

    await env.repo.tx(
      tx => tx.setProperty('t', aliasesProp, ['New']),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    const target = (await env.read('t'))!
    expect(target.content).toBe('see [[New]]')
    expect(JSON.parse(target.references_json)).toEqual([{id: 't', alias: 'New'}])
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

  it('keeps source links in wikilink form while an alias rename passes through a trailing-space value', async () => {
    await seedTarget('t', 'Old', ['Old'])
    await seedSource('s', 'See [[Old]] for context.')

    await env.repo.tx(
      tx => tx.setProperty('t', aliasesProp, ['Old ']),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    expect((await env.read('t'))!.content).toBe('Old ')
    expect((await env.read('s'))!.content).toBe('See [[Old ]] for context.')

    await env.repo.tx(
      tx => tx.setProperty('t', aliasesProp, ['Old word']),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    const target = (await env.read('t'))!
    expect(target.content).toBe('Old word')
    expect(JSON.parse(target.properties_json).alias).toEqual(['Old word'])
    expect((await env.read('s'))!.content).toBe('See [[Old word]] for context.')
  })

  it('keeps source links in wikilink form while a content rename passes through a trailing-space value', async () => {
    await seedTarget('t', 'Old', ['Old'])
    await seedSource('s', 'See [[Old]] for context.')

    await env.repo.mutate.setContent({id: 't', content: 'Old '})
    await flush()

    expect((await env.read('t'))!.content).toBe('Old ')
    expect(JSON.parse((await env.read('t'))!.properties_json).alias).toEqual(['Old '])
    expect((await env.read('s'))!.content).toBe('See [[Old ]] for context.')

    await env.repo.mutate.setContent({id: 't', content: 'Old word'})
    await flush()

    const target = (await env.read('t'))!
    expect(target.content).toBe('Old word')
    expect(JSON.parse(target.properties_json).alias).toEqual(['Old word'])
    expect((await env.read('s'))!.content).toBe('See [[Old word]] for context.')
  })
})

describe('rename — Case R4 (pure remove, some aliases remain)', () => {
  it('rewrites [[B]] → [B](((target-id))) on source content', async () => {
    await seedTarget(PIN_TARGET, '', ['A', 'B'])
    await seedSource('s', 'see [[B]] please')

    await env.repo.tx(
      tx => tx.setProperty(PIN_TARGET, aliasesProp, ['A']),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    expect((await env.read('s'))!.content).toBe(`see [B](((${PIN_TARGET}))) please`)
  })
})

describe('rename — Case R7 (remove last alias)', () => {
  it('rewrites [[A]] → [A](((target-id))) (only blockref form preserves the link)', async () => {
    await seedTarget(PIN_TARGET, '', ['A'])
    await seedSource('s', 'see [[A]] please')

    await env.repo.tx(
      tx => tx.setProperty(PIN_TARGET, aliasesProp, []),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    expect((await env.read('s'))!.content).toBe(`see [A](((${PIN_TARGET}))) please`)
  })
})

describe('rename — composition with sync (A2-cascade hits R4)', () => {
  it('content edit collapses an alias and rewrites source backlinks to blockref form', async () => {
    // Target before: content "X", aliases ["X","Y"]. User edits
    // content to "Y" — sync rule 1 fires: replace "X" with "Y" in
    // aliases, dedupe → ["Y"]. The cascading alias-swap is a pure
    // remove of "X" (Case A2 cascade → R4); rename rewrites [[X]] to
    // [X](((target-id))) in source backlinks.
    await seedTarget(PIN_TARGET, 'X', ['X', 'Y'])
    await seedSource('s', 'see [[X]] please')

    await env.repo.mutate.setContent({id: PIN_TARGET, content: 'Y'})
    await flush()

    expect((await env.read(PIN_TARGET))!.content).toBe('Y')
    expect(JSON.parse((await env.read(PIN_TARGET))!.properties_json).alias).toEqual(['Y'])
    expect((await env.read('s'))!.content).toBe(`see [X](((${PIN_TARGET}))) please`)
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
  it('does not rewrite whitespace-distinct aliases', async () => {
    await seedTarget('t', 'Old', ['Old'])
    await seedSource('s', 'see [[ Old ]] please')

    await env.repo.tx(
      tx => tx.setProperty('t', aliasesProp, ['New']),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    expect((await env.read('s'))!.content).toBe('see [[ Old ]] please')
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
  it('falls back to blockref form when the added alias is blank', async () => {
    // `renderWikilink('')` = `[[]]`, which parseReferences ignores —
    // emitting it would silently drop the backlink. Use blockref form.
    await seedTarget(PIN_TARGET, 'X', ['Old'])
    await seedSource('s', 'see [[Old]] please')

    await env.repo.tx(
      tx => tx.setProperty(PIN_TARGET, aliasesProp, ['']),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    expect((await env.read('s'))!.content).toBe(
      `see [Old](((${PIN_TARGET}))) please`,
    )
    // Backlink must actually resolve: parseReferences re-parses the
    // rewritten content, the aliased blockref pins to PIN_TARGET,
    // and the trigger-maintained `block_references` row carries
    // alias=PIN_TARGET (the blockref convention — alias === id).
    expect(await blockReferences('s', PIN_TARGET)).toEqual([{alias: PIN_TARGET}])
  })

  it('falls back to blockref form when the added alias does not roundtrip', async () => {
    // `renderWikilink('foo]]bar')` collapses `]]` to `] ]`; the result
    // parses to `foo] ]bar`, not the original alias. Emitting it
    // would corrupt the backlink text. Blockref form preserves intent.
    await seedTarget(PIN_TARGET, 'X', ['Old'])
    await seedSource('s', 'see [[Old]] please')

    await env.repo.tx(
      tx => tx.setProperty(PIN_TARGET, aliasesProp, ['foo]]bar']),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    expect((await env.read('s'))!.content).toBe(
      `see [Old](((${PIN_TARGET}))) please`,
    )
    expect(await blockReferences('s', PIN_TARGET)).toEqual([{alias: PIN_TARGET}])
  })
})

describe('rename — whole-span round-trip guard (§11 group 2)', () => {
  it('pins a span whose alias only survives sanitization, and reports the changed display text', async () => {
    // `]` is legal inside a wikilink alias (`[[a]b]]` parses to `a]b`)
    // but illegal inside an aliased-blockref label, so the pinned form
    // can only display `ab`. The LINK is what matters — dropping the
    // rewrite would strand the span on a name nothing claims — so the
    // rewrite proceeds and the lossy display text is reported.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await seedTarget(PIN_TARGET, '', ['a]b'])
      await seedSource('s', 'see [[a]b]] please')

      await env.repo.tx(
        tx => tx.setProperty(PIN_TARGET, aliasesProp, []),
        {scope: ChangeScope.BlockDefault},
      )
      await flush()

      expect((await env.read('s'))!.content).toBe(`see [ab](((${PIN_TARGET}))) please`)
      // The pinned span really binds: it re-parses to a blockref edge
      // whose alias is the id.
      expect(await blockReferences('s', PIN_TARGET)).toEqual([{alias: PIN_TARGET}])
      expect(warn.mock.calls.flat().join(' ')).toContain('sanitized text')
    } finally {
      warn.mockRestore()
    }
  })

  it('leaves the span unrewritten when the target cannot be pinned at all', async () => {
    // A non-UUID target has no representable aliased-blockref form:
    // `[A](((t)))` parses as prose, so splicing it would convert a live
    // backlink into text. The CONTENT is therefore left alone — but the
    // stored edge is not: `t` no longer owns `A`, and the renderer
    // resolves `[[A]]` through that edge, so leaving it there navigates
    // the span to a block that gave the name up. The edge is dropped,
    // and dropping it is what schedules the re-parse that re-binds the
    // span to whatever `[[A]]` means now (here: a fresh seat).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await seedTarget('t', '', ['A'])
      await seedSource('s', 'see [[A]] please')
      expect(await blockReferences('s', 't')).toEqual([{alias: 'A'}])

      await env.repo.tx(
        tx => tx.setProperty('t', aliasesProp, []),
        {scope: ChangeScope.BlockDefault},
      )
      await flush()

      expect((await env.read('s'))!.content).toBe('see [[A]] please')
      expect(await blockReferences('s', 't')).toEqual([])
      expect(await blockReferences('s', computeAliasSeatId('A', WS, 0)))
        .toEqual([{alias: 'A'}])
      expect(warn.mock.calls.flat().join(' ')).toContain('cannot pin a span')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('rename — post-tx claimant (§11 group 2)', () => {
  const refsOf = async (id: string) =>
    JSON.parse((await env.read(id))!.references_json) as Array<{id: string; alias: string}>

  it('leaves the span alone when the alias was handed off to another live block', async () => {
    // Handoff in one tx: T gives up "Shared", U takes it. `[[Shared]]`
    // already resolves where the author would expect, so rewriting it
    // — to a new alias of T's, or pinned to T — would steal the span
    // from the block that now owns the name.
    await seedTarget(PIN_TARGET, 'T', ['Shared'])
    await seedTarget('u', 'U', [])
    await seedSource('s', 'see [[Shared]] please')

    await env.repo.tx(async tx => {
      await tx.setProperty(PIN_TARGET, aliasesProp, [])
      await tx.setProperty('u', aliasesProp, ['Shared'])
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    expect((await env.read('s'))!.content).toBe('see [[Shared]] please')

    // Not rewriting is what keeps the span ABLE to follow the name:
    // the next re-parse binds it to U. (The stored entry stays on T
    // until something re-parses — the retained-binding half of #383,
    // untouched here.) Under the old behaviour the content would read
    // `[Shared](((T)))` and no amount of re-parsing could ever move
    // it off the block that gave the name up.
    await env.repo.mutate.setContent({id: 's', content: 'see [[Shared]] please!'})
    await flush()
    expect(await refsOf('s')).toEqual([{id: 'u', alias: 'Shared'}])
  })

  it('still rewrites when the only claimant is a machine seat', async () => {
    // The rename window: the rewrite CONSUMES the alias diff, so no flow
    // can rewrite content before the alias moves, and a re-derive landing
    // in that window mints an α-seat that CLAIMS the released name. It
    // must not count as a successor — treat it as one and the rewrite is
    // suppressed for every source, including the ordinary ones still
    // bound to the renaming block.
    await seedTarget(PIN_TARGET, 'T', ['Win'])
    await seedSource('s', 'see [[Win]] please')

    const seatId = computeAliasSeatId('Win', WS, 0)
    await env.repo.tx(async tx => {
      await tx.setProperty(PIN_TARGET, aliasesProp, [])
      await ensureAliasTarget(tx, env.repo, 'Win', WS)
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    expect((await env.read(seatId))!.content).toBe('Win')
    expect((await env.read('s'))!.content).toBe(`see [Win](((${PIN_TARGET}))) please`)
    expect(await refsOf('s')).toEqual([{id: PIN_TARGET, alias: PIN_TARGET}])
  })
})

describe('applyRefRewrites — surgical entry swap', () => {
  // This runs in the same tx as the content rewrite so the
  // `block_references` trigger refreshes in lockstep; parseReferences
  // later re-emits the same list. Asserting it through the processor
  // therefore proves nothing — the async re-parse produces the right
  // answer either way. The reason it exists is the window BEFORE that
  // re-parse, which a second rapid rename reads.
  const rw = (over: Partial<Rewrite>): Rewrite => Object.assign({
    alias: 'Win',
    replacement: `[Win](((${PIN_TARGET})))`,
    fromTargetId: PIN_TARGET,
    toTargetId: PIN_TARGET,
    refAlias: PIN_TARGET,
    seat: {slotIds: new Set<string>(), mintedAfter: 0, generatedFieldIds: []},
    pinned: true,
  } satisfies Rewrite, over)

  it('moves a window-bound edge off the seat — id and alias together', async () => {
    const seatId = computeAliasSeatId('Win', WS, 0)
    expect(applyRefRewrites(
      [{id: seatId, alias: 'Win'}],
      [rw({fromTargetId: seatId})],
    )).toEqual([{id: PIN_TARGET, alias: PIN_TARGET}])
  })

  it('leaves property-derived edges alone', async () => {
    expect(applyRefRewrites(
      [{id: PIN_TARGET, alias: 'Win', sourceField: 'ref'}],
      [rw({})],
    )).toEqual([{id: PIN_TARGET, alias: 'Win', sourceField: 'ref'}])
  })

  it('follows an edge that MOVED to a seat after the plan was built', async () => {
    // `fromTargetId` is a read-phase snapshot. `references.parseReferences`
    // can rebind this source's unchanged `[[Win]]` onto a freshly minted
    // Win-seat in the gap before the write tx — content untouched, so
    // `applyPlan`'s content guard never sees it, and the claimant
    // re-assert deliberately permits a pristine seat. Matching the stale
    // id alone rewrites the content while stranding the edge on the seat.
    const seatId = computeAliasSeatId('Win', WS, 0)
    expect(applyRefRewrites(
      [{id: seatId, alias: 'Win'}],
      [rw({fromTargetId: PIN_TARGET, seat: {slotIds: new Set([seatId]), mintedAfter: 0, generatedFieldIds: []}})],
    )).toEqual([{id: PIN_TARGET, alias: PIN_TARGET}])
  })

  it('keeps the old edge when a page embed survived the pinned rewrite', async () => {
    // `rewriteWikilinks` steps over `![[Win]]` for pinned replacements, so
    // a source holding both `[[Win]]` and `![[Win]]` still has a live
    // `Win` span afterwards — but `normalizeReferences` gave both
    // occurrences ONE entry. Swapping it outright drops the surviving
    // embed out of `block_references` until the async re-parse rebuilds
    // it, and a rename landing in that window cannot see the embed.
    const out = applyRefRewrites(
      [{id: PIN_TARGET, alias: 'Win'}],
      [rw({})],
      new Set(['Win']),
    )
    expect(out).toHaveLength(2)
    expect(out).toEqual(expect.arrayContaining([
      {id: PIN_TARGET, alias: 'Win'},
      {id: PIN_TARGET, alias: PIN_TARGET},
    ]))
    // Nothing retained when every occurrence was rewritten.
    expect(applyRefRewrites([{id: PIN_TARGET, alias: 'Win'}], [rw({})]))
      .toEqual([{id: PIN_TARGET, alias: PIN_TARGET}])
  })

  it('leaves an edge alone when its target is neither planned nor a seat slot', async () => {
    // The seat fallback is scoped to THIS alias's slot window, so an edge
    // pointing at some unrelated block that shares the alias text is not
    // ours to move.
    const other = '99999999-8888-4777-8666-555555555555'
    expect(applyRefRewrites(
      [{id: other, alias: 'Win'}],
      [rw({fromTargetId: PIN_TARGET, seat: {slotIds: new Set([computeAliasSeatId('Win', WS, 0)]), mintedAfter: 0, generatedFieldIds: []}})],
    )).toEqual([{id: other, alias: 'Win'}])
  })
})

describe('rename — seat classification hardening (#443 group 2 review)', () => {
  const refsOf = async (id: string) =>
    JSON.parse((await env.read(id))!.references_json) as Array<{id: string; alias: string}>

  it('does not hijack a PRE-EXISTING seat’s backlinks when a co-claimant releases the alias', async () => {
    // The seat exemption describes a PRISTINE seat, not one this rename
    // produced. Without a recency gate, a seat that has owned the name
    // since long before the releasing block existed satisfies the shape
    // checks identically — and following its edges re-points every
    // `[[Win]]` onto a block that never owned the name here.
    //
    // Reachable without any race: `block_aliases_workspace_alias_unique`
    // only fires for local user txs, so a SYNC-APPLIED row can co-claim
    // an alias a local seat already holds. A raw insert outside repo.tx
    // leaves `tx_context.source` NULL — the same shape.
    await seedSource('s', 'see [[Win]] please')
    const seatId = computeAliasSeatId('Win', WS, 0)
    expect((await env.read(seatId))!.deleted).toBe(0)
    expect(await refsOf('s')).toEqual([{id: seatId, alias: 'Win'}])

    await env.h.db.writeTransaction(async tx => {
      await tx.execute(
        `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
                             properties_json, references_json, created_at, updated_at,
                             created_by, updated_by, deleted)
         VALUES (?, ?, NULL, 'z0', 'Squatter', ?, '[]', 1, 1, 'u', 'u', 0)`,
        [PIN_TARGET, WS, JSON.stringify({alias: ['Win']})],
      )
    })

    await env.repo.tx(
      tx => tx.setProperty(PIN_TARGET, aliasesProp, []),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    // Untouched: the span still late-binds to the seat that owns the name.
    expect((await env.read('s'))!.content).toBe('see [[Win]] please')
    expect(await refsOf('s')).toEqual([{id: seatId, alias: 'Win'}])
    expect((await env.read(seatId))!.deleted).toBe(0)
  })

  it('still rewrites a window-bound span in a child-backed workspace', async () => {
    // Post-flip, `ensureAliasTarget`'s two setProperty calls route through
    // writePropertyValueChild, so EVERY seat is born with live children.
    // A bare "has live children?" gate doesn't just fail to recognize the
    // seat there — it inverts: the seat counts as a real claimant and
    // suppresses the rewrite entirely, which is worse than not having the
    // claimant check at all.
    await env.h.db.execute(
      `INSERT INTO workspaces
         (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
       VALUES (?, ?, ?, 1, 1, 'none', NULL, 'children')`,
      [WS, 'test ws', 'user-1'],
    )

    await seedTarget(PIN_TARGET, 'T', ['Win'])
    await seedSource('s', 'see [[Win]] please')

    const seatId = computeAliasSeatId('Win', WS, 0)
    await env.repo.tx(async tx => {
      await tx.setProperty(PIN_TARGET, aliasesProp, [])
      await ensureAliasTarget(tx, env.repo, 'Win', WS)
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    // The seat really was born with generated children here — otherwise
    // this test would pass for the wrong reason (an unflipped workspace
    // produces a childless seat, which the bare gate accepts anyway).
    // Queried WITHOUT `deleted = 0`: the rewrite orphans the seat and the
    // reaper soft-deletes it and its generated subtree, so by now the
    // live count is legitimately zero.
    const seatChildren = await env.h.db.getAll<{id: string; content: string}>(
      `SELECT id, content FROM blocks WHERE parent_id = ?`, [seatId])
    expect(seatChildren.length).toBeGreaterThan(0)
    expect(seatChildren.every(c => c.content.startsWith('::'))).toBe(true)
    expect((await env.read('s'))!.content).toBe(`see [Win](((${PIN_TARGET}))) please`)
  })

  it('counts a hand-written ref to a generated field definition as a blocking child', async () => {
    // The generated-children subtraction matches on `reference_target_id`,
    // but that column is stamped on ANY whole-block reference, not just
    // generated field rows: a child the user wrote as a bare
    // `((alias-property-definition))` carries the same target id with the
    // `::` marker bit unset. Subtracting on the id alone reads that
    // hand-written child as machinery, so a seat the user has already
    // adopted classifies as pristine — its backlinks get re-keyed, and
    // the orphan reaper is then free to delete the child with it.
    await env.h.db.execute(
      `INSERT INTO workspaces
         (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
       VALUES (?, ?, ?, 1, 1, 'none', NULL, 'children')`,
      [WS, 'test ws', 'user-1'],
    )

    await seedTarget(PIN_TARGET, 'T', ['Win'])
    await seedSource('s', 'see [[Win]] please')

    const seatId = computeAliasSeatId('Win', WS, 0)
    const aliasFieldId = propertyDefinitionBlockId(WS, aliasesProp.seedKey)
    await env.repo.tx(async tx => {
      await tx.setProperty(PIN_TARGET, aliasesProp, [])
      await ensureAliasTarget(tx, env.repo, 'Win', WS)
      // `core.deriveReferenceTarget` is a SAME-tx processor, so this
      // child's derived columns are already stamped when the post-commit
      // rename pass reads them.
      await tx.create({
        id: 'uc', workspaceId: WS, parentId: seatId, orderKey: 'm0',
        content: `((${aliasFieldId}))`,
      })
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    // The child really does carry the generated field's target id with the
    // marker bit unset — without this the test passes for the wrong
    // reason (an unstamped child blocks on the `IS NULL` leg anyway).
    const child = (await env.h.db.get<{reference_target_id: string | null; is_field_form: number | null}>(
      `SELECT reference_target_id, is_field_form FROM blocks WHERE id = 'uc'`))!
    expect(child.reference_target_id).toBe(aliasFieldId)
    expect(child.is_field_form).not.toBe(1)

    // Blocked: the seat carries user content, so it is not this window's
    // machinery and `[[Win]]` keeps late-binding to it.
    expect((await env.read('s'))!.content).toBe('see [[Win]] please')
  })
})

describe('rename — claimant re-assert inside the write tx (#443 group 2 review)', () => {
  it('drops the rewrite when the alias is claimed between the read phase and the write', async () => {
    // The read-phase claimant check is a committed-state read outside any
    // transaction, and `serializeRename` only serializes rename against
    // rename — anything else commits freely in the gap. `applyPlan`'s
    // content guard is structurally blind to this: a third party claiming
    // the alias never touches the SOURCE, so the source's content is
    // unchanged and the rewrite proceeds, pinning the span to the block
    // that just gave the name up. Irreversibly, and precisely the outcome
    // the claimant check exists to prevent.
    await seedTarget(PIN_TARGET, 'T', ['Shared'])
    await seedTarget('u', 'U', [])
    await seedSource('s', 'see [[Shared]] please')

    // Land the competing claim in the gap: the rename's plan is already
    // built when its write tx opens, so committing here reproduces the
    // interleaving deterministically.
    const realTx = env.repo.tx.bind(env.repo)
    let injected = false
    const txSpy = vi.spyOn(env.repo, 'tx').mockImplementation((async (fn: never, opts: never) => {
      const description = (opts as {description?: string} | undefined)?.description
      if (!injected && description?.includes(RENAME_BACKLINKS_PROCESSOR)) {
        injected = true
        await realTx(
          tx => tx.setProperty('u', aliasesProp, ['Shared']),
          {scope: ChangeScope.BlockDefault},
        )
      }
      return realTx(fn, opts)
    }) as never)

    try {
      await env.repo.tx(
        tx => tx.setProperty(PIN_TARGET, aliasesProp, []),
        {scope: ChangeScope.BlockDefault},
      )
      await flush()
      expect(injected).toBe(true)
    } finally {
      txSpy.mockRestore()
    }

    // Untouched — `[[Shared]]` still late-binds, and now to U.
    expect((await env.read('s'))!.content).toBe('see [[Shared]] please')
  })

  it('vetoes the renaming block itself when it re-claims the alias from its own seat slot', async () => {
    // Seats are adopted IN PLACE — a page born by typing `[[Win]]` keeps
    // its `computeAliasSeatId` slot id forever — so the renaming block is
    // very often a member of the seat window for the alias it is
    // releasing. Exempting claimants on the slot id ALONE therefore reads
    // an undo (the same block taking `Win` back in the gap) as "still
    // released", and R1 rewrites every `[[Win]]` to `[[Won]]`, a name
    // nothing claims once the undo lands. The block is left pristine here
    // deliberately: it satisfies every SHAPE check a real window seat
    // does, so only "you are the block being renamed" can veto it.
    await seedSource('s', 'see [[Win]] please')
    const seatId = computeAliasSeatId('Win', WS, 0)
    expect(await blockReferences('s', seatId)).toEqual([{alias: 'Win'}])
    // Snapshot the pristine seat row so the re-claim below restores it
    // EXACTLY — content equal to the alias, properties matching
    // `aliasSeatSeed`, id in the slot window. Restoring BOTH columns is
    // what an undo does, and it is what makes this sharp: every shape
    // signal then says "pristine window seat", and only identity says
    // otherwise. (Content has to come back too because the alias plugin
    // renames a seat's content along with its alias, so a
    // properties-only restore would trip the content check instead.)
    const pristine = (await env.read(seatId))!
    expect(pristine.content).toBe('Win')

    const realTx = env.repo.tx.bind(env.repo)
    let injected = false
    const txSpy = vi.spyOn(env.repo, 'tx').mockImplementation((async (fn: never, opts: never) => {
      const description = (opts as {description?: string} | undefined)?.description
      if (!injected && description?.includes(RENAME_BACKLINKS_PROCESSOR)) {
        injected = true
        // `Win` comes back to the very block that released it. Written
        // RAW, the shape a sync-applied re-claim has: `block_aliases` is
        // trigger-maintained so the claim is live immediately, but no
        // post-commit pass fires. That matters — a re-claim through
        // `repo.tx` would queue a rename of its own behind this one and
        // quietly rewrite `[[Won]]` back to `[[Win]]`, laundering the
        // damage and making this test pass no matter what the guard does.
        await env.h.db.writeTransaction(async tx => {
          await tx.execute(
            `UPDATE blocks SET content = ?, properties_json = ? WHERE id = ?`,
            [pristine.content, pristine.properties_json, seatId],
          )
        })
      }
      return realTx(fn, opts)
    }) as never)

    try {
      await env.repo.tx(
        tx => tx.setProperty(seatId, aliasesProp, ['Won']),
        {scope: ChangeScope.BlockDefault},
      )
      await flush()
      expect(injected).toBe(true)
    } finally {
      txSpy.mockRestore()
    }

    // The block really did end up looking exactly like a pristine window
    // seat for 'Win' again — the state in which only identity can veto.
    const seat = (await env.read(seatId))!
    expect(seat.content).toBe('Win')
    expect(seat.properties_json).toBe(pristine.properties_json)

    // `Win` is live again on that same block, so the span stays put.
    // Without the veto this becomes `[[Won]]` — a name nothing claims.
    expect((await env.read('s'))!.content).toBe('see [[Win]] please')
    expect(await blockReferences('s', seatId)).toEqual([{alias: 'Win'}])
  })
})

describe('rename — seat dating (#443 group 2, review round 2)', () => {
  const stamps = async (id: string) =>
    (await env.h.db.get<{created_at: number; user_updated_at: number | null}>(
      `SELECT created_at, user_updated_at FROM blocks WHERE id = ?`, [id]))!

  it('recognizes a seat materialized by RESTORE, whose created_at is ancient', async () => {
    // `resolveAliasSeatId` deliberately reuses a slot holding a pristine
    // tombstone so a hot name doesn't burn a fresh slot every reap cycle,
    // and `tx.restore` refreshes `user_updated_at` but never `created_at`
    // (immutable by contract). Dating the seat by `created_at` alone
    // reads a restored seat as ancient, rejects it, and skips the rename
    // — stranding the span on an empty stub that no later pass owns.
    await seedSource('s1', 'see [[Win]] please')
    const seatId = computeAliasSeatId('Win', WS, 0)
    await env.repo.mutate.setContent({id: 's1', content: ''})
    await flush()
    expect((await env.read(seatId))!.deleted).toBe(1)
    const bornAt = (await stamps(seatId)).created_at

    await seedTarget(PIN_TARGET, 'T', ['Win'])
    await seedSource('s', 'see [[Win]] please')

    await env.repo.tx(async tx => {
      await tx.setProperty(PIN_TARGET, aliasesProp, [])
      await ensureAliasTarget(tx, env.repo, 'Win', WS)
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    // It really was a restore, not a fresh mint at a new slot.
    expect((await stamps(seatId)).created_at).toBe(bornAt)
    expect((await env.read('s'))!.content).toBe(`see [Win](((${PIN_TARGET}))) please`)
  })

  it('does not hijack when the alias write left the display stamp stale', async () => {
    // `metadataPatch` leaves `user_updated_at` untouched on a
    // `{skipMetadata}` write while still advancing `updated_at`. Several
    // paths write the alias cell that way — notably
    // `core.projectPropertyChildren`, the post-flip rename gesture. Dating
    // the commit by the display stamp reads whatever the page's last REAL
    // edit was, which can be older than the seat, so a long-lived seat
    // passes as window-minted and its backlinks get hijacked.
    //
    // Seat first, so it is the oldest claimant and `s` binds to it; `T`
    // co-claims via a raw (sync-shaped) insert that bypasses the
    // uniqueness trigger, carrying a display stamp frozen BEHIND the
    // seat's creation.
    await seedSource('s', 'see [[Win]] please')
    const seatId = computeAliasSeatId('Win', WS, 0)
    const seatBorn = (await stamps(seatId)).created_at
    expect(await blockReferences('s', seatId)).toEqual([{alias: 'Win'}])

    await env.h.db.writeTransaction(async tx => {
      await tx.execute(
        `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
                             properties_json, references_json, created_at, updated_at,
                             user_updated_at, created_by, updated_by, deleted)
         VALUES (?, ?, NULL, 'z0', 'T', ?, '[]', ?, ?, ?, 'u', 'u', 0)`,
        [PIN_TARGET, WS, JSON.stringify({alias: ['Win']}),
         seatBorn + 1, seatBorn + 1, seatBorn - 1],
      )
    })

    // Release through a bookkeeping write — the shape that freezes
    // `user_updated_at` while still advancing the row version.
    await env.repo.tx(
      tx => tx.update(PIN_TARGET, {properties: {}}, {skipMetadata: true}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    expect((await stamps(PIN_TARGET)).user_updated_at).toBe(seatBorn - 1)
    expect((await env.read('s'))!.content).toBe('see [[Win]] please')
    expect(await blockReferences('s', seatId)).toEqual([{alias: 'Win'}])
  })

  it('vetoes a gap-arriving claimant that is YOUNGER than the window seat', async () => {
    // The in-tx re-assert must see every claimant. `aliasLookup` is
    // `ORDER BY created_at LIMIT 1`, so when the window seat is older
    // than the competitor — the normal ordering, since the competitor is
    // newly created or newly synced — it returns the SEAT, the seat check
    // passes, and the rewrite proceeds into the hijack this guard exists
    // to stop.
    await seedTarget(PIN_TARGET, 'T', ['Win'])
    await seedSource('s', 'see [[Win]] please')
    const seatId = computeAliasSeatId('Win', WS, 0)

    const realTx = env.repo.tx.bind(env.repo)
    let injected = false
    const txSpy = vi.spyOn(env.repo, 'tx').mockImplementation((async (fn: never, opts: never) => {
      const description = (opts as {description?: string} | undefined)?.description
      if (!injected && description?.includes(RENAME_BACKLINKS_PROCESSOR)) {
        injected = true
        const seatBorn = (await stamps(seatId)).created_at
        await env.h.db.writeTransaction(async raw => {
          await raw.execute(
            `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
                                 properties_json, references_json, created_at, updated_at,
                                 user_updated_at, created_by, updated_by, deleted)
             VALUES ('newpage', ?, NULL, 'z9', 'New Page', ?, '[]', ?, ?, ?, 'u', 'u', 0)`,
            [WS, JSON.stringify({alias: ['Win']}),
             seatBorn + 1, seatBorn + 1, seatBorn + 1],
          )
        })
      }
      return realTx(fn, opts)
    }) as never)

    try {
      await env.repo.tx(async tx => {
        await tx.setProperty(PIN_TARGET, aliasesProp, [])
        await ensureAliasTarget(tx, env.repo, 'Win', WS)
        }, {scope: ChangeScope.BlockDefault})
      await flush()
      expect(injected).toBe(true)
    } finally {
      txSpy.mockRestore()
    }

    expect((await env.read('s'))!.content).toBe('see [[Win]] please')
  })
})

describe('rename — Codex round 2 (#444)', () => {
  it('rebinds the edge when the alias is handed off to another block', async () => {
    // Handoff: the span text is correct as written — `[[Shared]]` should
    // now mean U — so the content is deliberately left alone. The stored
    // EDGE is a different matter: `wikilinkMarkdownExtension` builds its
    // alias→id map from the block's references, so an edge still naming
    // T makes the rendered link navigate to the block that gave the name
    // up. And because this branch used to write nothing at all, no
    // watched field changed and `parseReferences` was never scheduled to
    // notice — the wrong destination was permanent.
    await seedTarget(PIN_TARGET, 'T', ['Shared'])
    await seedTarget('u', 'U', [])
    await seedSource('s', 'see [[Shared]] please')
    expect(await blockReferences('s', PIN_TARGET)).toEqual([{alias: 'Shared'}])

    await env.repo.tx(async tx => {
      await tx.setProperty(PIN_TARGET, aliasesProp, [])
      await tx.setProperty('u', aliasesProp, ['Shared'])
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    expect((await env.read('s'))!.content).toBe('see [[Shared]] please')
    expect(await blockReferences('s', PIN_TARGET)).toEqual([])
    expect(await blockReferences('s', 'u')).toEqual([{alias: 'Shared'}])
  })

  it('classifies a gap claimant per rewrite, not once per alias', async () => {
    // Two sync-created co-claimants of `Win` release it in ONE commit, so
    // one `ReleaseCache` serves both rewrites — but they differ in
    // `toTargetId` and `mintedAfter`, and `isWindowMintedSeatInTx` reads
    // both. `B`'s row version is parked far in the future, so a seat
    // landing in the gap is NEWER than `A`'s commit (valid window
    // machinery, rewrite proceeds) and OLDER than `B`'s (a pre-existing
    // seat, veto). Keyed on `(workspace, alias)` alone, whichever
    // resolved first answered for both.
    const A = '22222222-3333-4444-8555-666666666666'
    const B = '33333333-4444-4555-8666-777777777777'
    const seatId = computeAliasSeatId('Win', WS, 0)
    const FUTURE = 9000000000000
    const SEAT_STAMP = 5000000000000

    await env.h.db.writeTransaction(async tx => {
      for (const [id, content, stamp] of [[A, 'A', 1], [B, 'B', FUTURE]] as const) {
        await tx.execute(
          `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
                               properties_json, references_json, created_at, updated_at,
                               user_updated_at, created_by, updated_by, deleted)
           VALUES (?, ?, NULL, 'z0', ?, ?, '[]', 1, ?, 1, 'u', 'u', 0)`,
          [id, WS, content, JSON.stringify({alias: ['Win']}), stamp],
        )
      }
    })
    await seedSource('sA', 'see [[Win]] please')
    await seedSource('sB', 'see [[Win]] please')
    // Written RAW. A re-parse resolves `[[Win]]` to the single alias
    // winner, so an edge onto the OTHER co-claimant only exists the way
    // it does in life: applied by sync, never re-derived locally.
    await env.h.db.writeTransaction(async tx => {
      for (const [source, target] of [['sA', A], ['sB', B]] as const) {
        await tx.execute(
          `UPDATE blocks SET references_json = ? WHERE id = ?`,
          [JSON.stringify([{id: target, alias: 'Win'}]), source],
        )
      }
    })

    const realTx = env.repo.tx.bind(env.repo)
    let injected = false
    const txSpy = vi.spyOn(env.repo, 'tx').mockImplementation((async (fn: never, opts: never) => {
      const description = (opts as {description?: string} | undefined)?.description
      if (!injected && description?.includes(RENAME_BACKLINKS_PROCESSOR)) {
        injected = true
        await env.h.db.writeTransaction(async tx => {
          await tx.execute(
            `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
                                 properties_json, references_json, created_at, updated_at,
                                 user_updated_at, created_by, updated_by, deleted)
             VALUES (?, ?, NULL, 'z1', 'Win', ?, '[]', ?, ?, ?, 'u', 'u', 0)`,
            [seatId, WS, JSON.stringify(aliasSeatSeed('Win').properties),
             SEAT_STAMP, SEAT_STAMP, SEAT_STAMP],
          )
        })
      }
      return realTx(fn, opts)
    }) as never)

    try {
      await env.repo.tx(async tx => {
        await tx.update(A, {properties: {}}, {skipMetadata: true})
        await tx.update(B, {properties: {}}, {skipMetadata: true})
      }, {scope: ChangeScope.BlockDefault})
      await flush()
      expect(injected).toBe(true)
    } finally {
      txSpy.mockRestore()
    }

    // A's window: the seat postdates its commit, so it is machinery and
    // A's backlink re-keys. B's: the seat predates its commit, so it is a
    // real claimant and B's backlink must be left alone.
    expect((await env.read('sA'))!.content).toBe(`see [Win](((${A}))) please`)
    expect((await env.read('sB'))!.content).toBe('see [[Win]] please')
  })

  it('leaves a seat-bound span alone rather than guess how it got there', async () => {
    // Two histories produce this exact state, and nothing distinguishes
    // them: a PRE-EXISTING `[[Win]]` whose edge a window re-derive moved
    // onto the fresh seat, or a `[[Win]]` the USER TYPED after the
    // release, which the parser legitimately bound to that seat. The
    // second is a link they deliberately aimed at the new page;
    // rewriting it hands it to the block that just gave up the name.
    //
    // The source's own stamp cannot separate them either — the re-derive
    // writes `references` and `skipMetadata` still ratchets
    // `updated_at`, so both bump it — and the content guard cannot,
    // because a pre-read-phase edit is already in `originalContent`.
    // So the span stays put: a working late-binding link to a stub.
    await seedTarget(PIN_TARGET, 'T', ['Win'])
    await seedSource('s', 'see [[Win]] please')

    const seatId = computeAliasSeatId('Win', WS, 0)
    await env.repo.tx(async tx => {
      await tx.setProperty(PIN_TARGET, aliasesProp, [])
      await ensureAliasTarget(tx, env.repo, 'Win', WS)
      await tx.update('s', {references: [{id: seatId, alias: 'Win'}]}, {skipMetadata: true})
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    expect((await env.read(seatId))!.content).toBe('Win')
    expect((await env.read('s'))!.content).toBe('see [[Win]] please')
  })

  it('rejects a seat whose stamp merely TIES the rename commit', () => {
    // The stated invariant is "materialized AFTER the commit we are
    // reacting to". A tie does not say that: `seatMaterializedAt` can
    // take `user_updated_at` straight off a synced row, stamped by
    // another device's clock, so an equal value is coincidence rather
    // than evidence. Rejecting a tie only skips a rewrite; accepting one
    // on a seat that predates us hijacks its backlinks.
    const row = (stamp: number): SeatCandidateRow => ({
      targetId: computeAliasSeatId('Win', WS, 0),
      targetContent: 'Win',
      targetProperties: JSON.stringify(aliasSeatSeed('Win').properties),
      targetCreatedAt: stamp,
      targetUserUpdatedAt: null,
      targetBlockingChildren: 0,
    })
    const ctx = seatClassificationCtx('Win', WS, 100, [])
    expect(isWindowMintedAliasSeat(row(100), 'Win', ctx)).toBe(false)
    expect(isWindowMintedAliasSeat(row(101), 'Win', ctx)).toBe(true)
  })

  it('vetoes a gap-arriving seat that PREDATES the rename commit', async () => {
    // Sync can materialize a long-lived pristine seat from another device
    // in the read→write gap. On slot id and shape alone it is
    // indistinguishable from a seat this rename just minted — only the
    // stamp separates them, and the in-tx re-assert skipped that check
    // entirely, so the arriving seat read as our own machinery and its
    // backlinks were re-pointed at the block that released the name.
    await seedTarget(PIN_TARGET, 'T', ['Win'])
    await seedSource('s', 'see [[Win]] please')
    const seatId = computeAliasSeatId('Win', WS, 0)

    const realTx = env.repo.tx.bind(env.repo)
    let injected = false
    const txSpy = vi.spyOn(env.repo, 'tx').mockImplementation((async (fn: never, opts: never) => {
      const description = (opts as {description?: string} | undefined)?.description
      if (!injected && description?.includes(RENAME_BACKLINKS_PROCESSOR)) {
        injected = true
        // Raw + sync-shaped: exact seat seed, ANCIENT stamps.
        await env.h.db.writeTransaction(async tx => {
          await tx.execute(
            `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
                                 properties_json, references_json, created_at, updated_at,
                                 user_updated_at, created_by, updated_by, deleted)
             VALUES (?, ?, NULL, 'z0', 'Win', ?, '[]', 1, 1, 1, 'u', 'u', 0)`,
            [seatId, WS, JSON.stringify(aliasSeatSeed('Win').properties)],
          )
        })
      }
      return realTx(fn, opts)
    }) as never)

    try {
      await env.repo.tx(
        tx => tx.setProperty(PIN_TARGET, aliasesProp, []),
        {scope: ChangeScope.BlockDefault},
      )
      await flush()
      expect(injected).toBe(true)
    } finally {
      txSpy.mockRestore()
    }

    // The arriving seat owns `Win`, so the span keeps late-binding to it.
    expect((await env.read('s'))!.content).toBe('see [[Win]] please')
  })

  /** Land a pristine-shaped seat for `Win` in the read→write gap, with
   *  whatever subtree `children` adds, and return the source's content
   *  after the rename has run. Stamped far in the FUTURE so the recency
   *  leg can never be what vetoes — only the children signal can. */
  const renameWithGapSeat = async (
    children: (exec: (sql: string, args: unknown[]) => Promise<unknown>, seatId: string) => Promise<void>,
  ): Promise<string> => {
    await seedTarget(PIN_TARGET, 'T', ['Win'])
    await seedSource('s', 'see [[Win]] please')
    const seatId = computeAliasSeatId('Win', WS, 0)

    const realTx = env.repo.tx.bind(env.repo)
    let injected = false
    const txSpy = vi.spyOn(env.repo, 'tx').mockImplementation((async (fn: never, opts: never) => {
      const description = (opts as {description?: string} | undefined)?.description
      if (!injected && description?.includes(RENAME_BACKLINKS_PROCESSOR)) {
        injected = true
        await env.h.db.writeTransaction(async tx => {
          const exec = (sql: string, args: unknown[]) => tx.execute(sql, args as never)
          await exec(
            `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
                                 properties_json, references_json, created_at, updated_at,
                                 user_updated_at, created_by, updated_by, deleted)
             VALUES (?, ?, NULL, 'z0', 'Win', ?, '[]', ?, ?, ?, 'u', 'u', 0)`,
            [seatId, WS, JSON.stringify(aliasSeatSeed('Win').properties),
             9999999999999, 9999999999999, 9999999999999],
          )
          await children(exec, seatId)
        })
      }
      return realTx(fn, opts)
    }) as never)

    try {
      await env.repo.tx(
        tx => tx.setProperty(PIN_TARGET, aliasesProp, []),
        {scope: ChangeScope.BlockDefault},
      )
      await flush()
      expect(injected).toBe(true)
    } finally {
      txSpy.mockRestore()
    }
    return (await env.read('s'))!.content
  }

  const rawRow = (
    id: string, parent: string, content: string, fieldId?: string,
  ): [string, unknown[]] => [
    `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
                         properties_json, references_json, reference_target_id,
                         is_field_form, created_at, updated_at, created_by,
                         updated_by, deleted)
     VALUES (?, ?, ?, 'a0', ?, '{}', '[]', ?, ?, 1, 1, 'u', 'u', 0)`,
    [id, WS, parent, content, fieldId ?? null, fieldId === undefined ? null : 1],
  ]

  it('vetoes a gap-arriving seat carrying a plain user child', async () => {
    // An adopted page sitting at a seat slot: its child is not one of the
    // seat's own generated field rows, so it blocks outright.
    const content = await renameWithGapSeat(async (exec, seatId) => {
      const [sql, args] = rawRow('kid', seatId, 'a page note')
      await exec(sql, args)
    })
    expect(content).toBe('see [[Win]] please')
  })

  it('vetoes a gap-arriving seat carrying a DUPLICATE generated field row', async () => {
    // Both rows are shaped exactly like machinery — recognized definition
    // target, `::` marker set, one leaf value child each. Only the fact
    // that there are TWO of them says a user built one.
    const fieldId = propertyDefinitionBlockId(WS, aliasesProp.seedKey)
    await env.h.db.execute(
      `INSERT INTO workspaces
         (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
       VALUES (?, ?, ?, 1, 1, 'none', NULL, 'children')`,
      [WS, 'test ws', 'user-1'],
    )
    const content = await renameWithGapSeat(async (exec, seatId) => {
      for (const r of [
        rawRow('fieldrow', seatId, `::((${fieldId}))`, fieldId),
        rawRow('value', 'fieldrow', 'Win'),
        rawRow('dupe', seatId, `::((${fieldId}))`, fieldId),
        rawRow('dupevalue', 'dupe', 'Win'),
      ]) await exec(r[0], r[1])
    })
    expect(content).toBe('see [[Win]] please')
  })

  it('vetoes a gap-arriving seat with a note beside a generated value child', async () => {
    // Here every direct child IS generated machinery, so the shallow
    // signal clears it — the user data is one level further down, beside
    // the field row's single value child. Needs the flipped workspace:
    // un-flipped, `generatedFieldIds` is empty, nothing is recognized as
    // machinery, and the field row would block on the shallow leg
    // instead — passing for the wrong reason.
    await env.h.db.execute(
      `INSERT INTO workspaces
         (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
       VALUES (?, ?, ?, 1, 1, 'none', NULL, 'children')`,
      [WS, 'test ws', 'user-1'],
    )
    const fieldId = propertyDefinitionBlockId(WS, aliasesProp.seedKey)
    const content = await renameWithGapSeat(async (exec, seatId) => {
      for (const row of [
        rawRow('fieldrow', seatId, `::((${fieldId}))`, fieldId),
        rawRow('value', 'fieldrow', 'Win'),
        rawRow('beside', 'fieldrow', 'stray note'),
      ]) await exec(row[0], row[1])
    })
    expect(content).toBe('see [[Win]] please')
  })

  it('sees user content nested under a generated field row', async () => {
    // The direct-children signal subtracts a generated field row
    // wholesale, so a comment thread parked under its value child is
    // invisible to it — and the seat reads as pristine machinery. Same
    // rule as the orphan reaper's deep guard: a machine seat's generated
    // subtree is exactly field row → at most ONE leaf value child.
    const seatId = computeAliasSeatId('Win', WS, 0)
    const fieldId = propertyDefinitionBlockId(WS, aliasesProp.seedKey)
    const row = async (id: string, parent: string, content: string, fieldForm: boolean) =>
      env.h.db.execute(
        `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
                             properties_json, references_json, reference_target_id,
                             is_field_form, created_at, updated_at, created_by,
                             updated_by, deleted)
         VALUES (?, ?, ?, 'a0', ?, '{}', '[]', ?, ?, 1, 1, 'u', 'u', 0)`,
        [id, WS, parent, content, fieldForm ? fieldId : null, fieldForm ? 1 : null],
      )
    await row(seatId, null as unknown as string, 'Win', false)
    await row('fieldrow', seatId, `::((${fieldId}))`, true)
    await row('value', 'fieldrow', 'Win', false)

    // Field row → one leaf value child is pure machinery.
    expect(await hasDeepUserContent(env.h.db, seatId, [fieldId])).toBe(false)
    // A comment thread UNDER the value child is user data.
    await row('note', 'value', 'my note', false)
    expect(await hasDeepUserContent(env.h.db, seatId, [fieldId])).toBe(true)
    // And so is a second live child beside the value child.
    await env.h.db.execute(`UPDATE blocks SET deleted = 1 WHERE id = 'note'`)
    expect(await hasDeepUserContent(env.h.db, seatId, [fieldId])).toBe(false)
    await row('beside', 'fieldrow', 'stray note', false)
    expect(await hasDeepUserContent(env.h.db, seatId, [fieldId])).toBe(true)

    // Un-flipped workspaces have no generated rows to look under.
    expect(await hasDeepUserContent(env.h.db, seatId, [])).toBe(false)

    // A DUPLICATE field row for the same definition is user-authored
    // whatever its subtree looks like — `ensureAliasTarget` writes each
    // generated property exactly once. Per-row shape testing accepts it
    // (one leaf value child, same as the real one), and the original
    // stays the projection winner so the seat's bag still matches the
    // seed, leaving nothing else to notice the adoption.
    await env.h.db.execute(`UPDATE blocks SET deleted = 1 WHERE id = 'beside'`)
    expect(await hasDeepUserContent(env.h.db, seatId, [fieldId])).toBe(false)
    await row('dupe', seatId, `::((${fieldId}))`, true)
    await row('dupevalue', 'dupe', 'Win', false)
    expect(await hasDeepUserContent(env.h.db, seatId, [fieldId])).toBe(true)
  })

  it('does not treat a seat with user content under a generated field row as pristine', async () => {
    // Post-flip a seat is born with generated field rows, which the
    // children signal subtracts wholesale — so a note the user parked
    // beside the alias field row's value child is invisible to the
    // direct-children test and the seat reads as machinery. Its backlinks
    // are then re-keyed and the orphan reaper takes the note with the
    // seat. Same guard the reaper already carries for its own sweep.
    await env.h.db.execute(
      `INSERT INTO workspaces
         (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
       VALUES (?, ?, ?, 1, 1, 'none', NULL, 'children')`,
      [WS, 'test ws', 'user-1'],
    )
    await seedTarget(PIN_TARGET, 'T', ['Win'])
    await seedSource('s', 'see [[Win]] please')

    const seatId = computeAliasSeatId('Win', WS, 0)
    const aliasFieldId = propertyDefinitionBlockId(WS, aliasesProp.seedKey)
    let fieldRowId = ''
    let valueChildId = ''
    await env.repo.tx(async tx => {
      await tx.setProperty(PIN_TARGET, aliasesProp, [])
      await ensureAliasTarget(tx, env.repo, 'Win', WS)
      const kids = await tx.childrenOf(seatId)
      fieldRowId = kids.find(k => k.referenceTargetId === aliasFieldId)!.id
      // UNDER the value child, not beside it — a comment thread on the
      // property value. Parking it as a second child of the field row
      // would instead make `core.projectPropertyChildren` fold it into
      // the projected alias value, and the seat would fail the SHAPE
      // check rather than this one, which proves nothing about the
      // deep guard.
      const valueChildren = await tx.childrenOf(fieldRowId)
      valueChildId = valueChildren[0]!.id
      await tx.create({
        id: 'note', workspaceId: WS, parentId: valueChildId, orderKey: 'z9',
        content: 'my note',
      })
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    // The note really is two levels under the seat, and the seat's own
    // shape is still pristine — so the ONLY thing that can veto here is
    // the deep guard, not the direct-children or shape signals.
    expect(fieldRowId).not.toBe('')
    const note = (await env.h.db.get<{parent_id: string}>(
      `SELECT parent_id FROM blocks WHERE id = 'note'`))!
    expect(note.parent_id).toBe(valueChildId)
    const fieldRowKids = await env.h.db.getAll<{id: string}>(
      `SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0`, [fieldRowId])
    expect(fieldRowKids).toHaveLength(1)
    expect((await env.read(seatId))!.properties_json)
      .toBe(JSON.stringify(aliasSeatSeed('Win').properties))

    expect((await env.read('s'))!.content).toBe('see [[Win]] please')
  })
})
