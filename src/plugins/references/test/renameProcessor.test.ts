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
import { computeAliasSeatId, ensureAliasTarget } from '@/data/targets'
import { referencesDataExtension } from '../dataExtension.ts'
import {
  applyRefRewrites,
  RENAME_BACKLINKS_PROCESSOR,
  type Rewrite,
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
    // backlink into text. Keeping `[[A]]` keeps the stored reference
    // entry pointing at the target.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await seedTarget('t', '', ['A'])
      await seedSource('s', 'see [[A]] please')

      await env.repo.tx(
        tx => tx.setProperty('t', aliasesProp, []),
        {scope: ChangeScope.BlockDefault},
      )
      await flush()

      expect((await env.read('s'))!.content).toBe('see [[A]] please')
      expect(await blockReferences('s', 't')).toEqual([{alias: 'A'}])
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

  it('still rewrites when the only claimant is a machine seat, and follows the span onto it', async () => {
    // The rename window: the rename rewrite CONSUMES the alias diff, so
    // no flow can rewrite content before the alias moves. A re-derive
    // landing in that window mints an α-seat and re-binds the span to
    // it. The seat must not count as a successor (it would suppress the
    // rewrite) and the seat-bound edge must still be found (the old
    // (target_id, alias) enumeration missed it) — otherwise the span is
    // permanently stranded on a throwaway seat.
    await seedTarget(PIN_TARGET, 'T', ['Win'])
    await seedSource('s', 'see [[Win]] please')

    const seatId = computeAliasSeatId('Win', WS, 0)
    await env.repo.tx(async tx => {
      await tx.setProperty(PIN_TARGET, aliasesProp, [])
      await ensureAliasTarget(tx, env.repo, 'Win', WS)
      // What the window's re-derive would have written.
      await tx.update('s', {references: [{id: seatId, alias: 'Win'}]}, {skipMetadata: true})
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    expect((await env.read('s'))!.content).toBe(`see [Win](((${PIN_TARGET}))) please`)
    // The entry moved off the seat too — id AND alias, not just alias.
    expect(await refsOf('s')).toEqual([{id: PIN_TARGET, alias: PIN_TARGET}])
    // …which drops the seat's last reference, so the already-landed
    // reference-drop reaper (`references.reapOrphanAliasSeats`, #402)
    // collects it. This is the composition §11 group 1(c) describes:
    // the rewrite doesn't schedule cleanup itself, it produces the
    // derived transition the reaper observes. Without the rewrite the
    // seat keeps squatting the released name — its own mint-time 4s
    // check already ran while the span still referenced it.
    expect((await env.read(seatId))!.deleted).toBe(1)
  })
})

describe('applyRefRewrites — surgical entry swap', () => {
  // This runs in the same tx as the content rewrite so the
  // `block_references` trigger refreshes in lockstep; parseReferences
  // later re-emits the same list. Asserting it through the processor
  // therefore proves nothing — the async re-parse produces the right
  // answer either way. The reason it exists is the window BEFORE that
  // re-parse, which a second rapid rename reads.
  const rw = (over: Partial<Rewrite>): Rewrite => ({
    alias: 'Win',
    replacement: `[Win](((${PIN_TARGET})))`,
    fromTargetId: PIN_TARGET,
    toTargetId: PIN_TARGET,
    refAlias: PIN_TARGET,
    seatIds: new Set<string>(),
    ...over,
  })

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
      await tx.update('s', {references: [{id: seatId, alias: 'Win'}]}, {skipMetadata: true})
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
})
