// @vitest-environment node
/**
 * Integration tests for the `references.renameBacklinks` SAME-TX
 * processor (cases R1, R4, R7 + the A2-cascade in
 * docs/alias-rename-cases.html). Drives the full pipeline through
 * `repo.tx` so the field-watcher fires; the alias plugin's sync
 * processor also runs, since composition (sync writes a swap, rename
 * acts on it in the same pass) is part of the spec.
 *
 * Rename must run AFTER `alias.sync` — it reacts to the alias diff sync
 * writes for a title edit — and says so with an explicit facet PRECEDENCE
 * (`RENAME_BACKLINKS_PRECEDENCE`), not by extension position. Drop that
 * precedence and every content-rename test in this file fails, which is
 * the point: the ordering is load-bearing, not incidental.
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
  splitBySurvivingSpan,
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

/** The two LOCAL derived columns — what makes a row a field row (§7/§9).
 *  `env.read` doesn't select them (they're device-local reflections of
 *  content, not part of the synced row the other assertions look at). */
const derivedColumns = async (id: string) =>
  env.h.db.get<{reference_target_id: string | null; is_field_form: 1 | null}>(
    'SELECT reference_target_id, is_field_form FROM blocks WHERE id = ?', [id],
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

describe('rename — atomicity with the originating commit (#461)', () => {
  it('rewrites the backlink inside the rename tx, so ONE undo restores both', async () => {
    // The headline of the same-tx conversion. Post-commit, the rewrite
    // landed in its own `ChangeScope.References` tx — a second undo entry
    // in a different bucket, so cmd-Z put the title back and left every
    // backlink reading the new name. Now both halves are one commit.
    await seedTarget('t', 'Old', ['Old'])
    await seedSource('s', 'See [[Old]] for context.')

    await env.repo.mutate.setContent({id: 't', content: 'New'})
    await flush()
    expect((await env.read('s'))!.content).toBe('See [[New]] for context.')

    expect(await env.repo.undo()).toBe(true)
    await flush()
    expect((await env.read('t'))!.content).toBe('Old')
    expect(JSON.parse((await env.read('t'))!.properties_json).alias).toEqual(['Old'])
    expect((await env.read('s'))!.content).toBe('See [[Old]] for context.')
  })

  it('writes content and references in lockstep, so the follow-up parse is a no-op', async () => {
    // The rewrite must leave `references` exactly where a re-parse of the
    // rewritten content would put it. If it didn't, the post-commit
    // `parseReferences` would issue a SECOND write in its own
    // `References`-scope tx — a second undo entry, and the atomicity above
    // would be a fiction. Compare the row version before and after the
    // parse has had a chance to run.
    await seedTarget('t', 'Old', ['Old'])
    await seedSource('s', 'See [[Old]] for context.')

    const version = async () => (await env.h.db.get<{updated_at: number}>(
      `SELECT updated_at FROM blocks WHERE id = 's'`)).updated_at

    await env.repo.tx(
      tx => tx.setProperty('t', aliasesProp, ['New']),
      {scope: ChangeScope.BlockDefault},
    )
    const afterCommit = await version()
    await flush()

    expect((await env.read('s'))!.content).toBe('See [[New]] for context.')
    expect(JSON.parse((await env.read('s'))!.references_json))
      .toEqual([{id: 't', alias: 'New'}])
    // Nothing wrote `s` after the rename tx committed.
    expect(await version()).toBe(afterCommit)
  })
})

describe('rename — rapid title edits cascade fully', () => {
  it('source backlinks resolve to the final target alias after rapid edits', async () => {
    // Two rapid title renames, each its own commit. The second rename's
    // `block_references` read has to see the first rename's rewrite —
    // otherwise the index still says alias="Old", the lookup for
    // alias="New name" returns nothing, and the source stays at
    // `[[New name]]`, which no longer resolves to the target (whose
    // aliases are now ["Brand new"]). Same-tx makes that automatic: the
    // first rename's `references` write and the alias write commit
    // together, so there is no interval where the projection disagrees
    // with the aliases. Kept as a regression test of the end state.
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

describe('rename — marked name rows re-key to canonical ::((A)) (§11 group 2)', () => {
  // The last open arm of group 2: "its lossy-name fallback for MARKED rows is
  // canonical `::((A))`, never a pinned label". A marked row is a property
  // field row (§7) — it renders its property NAME, resolved through the
  // definition its id points at — so a pinned label is text the row never
  // displays. The tier is chosen per SOURCE, not per alias.

  it('re-keys a marked name row to ::((A)) where a prose span gets the pinned label', async () => {
    // Both referrers in ONE commit, so this also pins the partitioning: a
    // blanket switch to the canonical form would break the prose span's
    // display text, and no switch at all would leave the marked row with an
    // invented label.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await seedTarget(PIN_TARGET, '', ['Status'])
      await seedSource('marked', '::[[Status]]')
      await seedSource('prose', 'tracked in [[Status]] today')

      await env.repo.tx(
        tx => tx.setProperty(PIN_TARGET, aliasesProp, []),
        {scope: ChangeScope.BlockDefault},
      )
      await flush()

      expect((await env.read('marked'))!.content).toBe(`::((${PIN_TARGET}))`)
      expect((await env.read('prose'))!.content)
        .toBe(`tracked in [Status](((${PIN_TARGET}))) today`)
      // Both still bind, and the marked row is still a field row: the
      // canonical form keeps BOTH derived columns, which is what makes it
      // machinery at all.
      expect(await blockReferences('marked', PIN_TARGET)).toEqual([{alias: PIN_TARGET}])
      expect(await derivedColumns('marked'))
        .toEqual({reference_target_id: PIN_TARGET, is_field_form: 1})
    } finally {
      warn.mockRestore()
    }
  })

  it('re-keys a LOSSY-name marked row cleanly, with no sanitized display to report', async () => {
    // The behavioural gain, and the case the doc's wording names. `]` is legal
    // in a wikilink alias but illegal in an aliased-blockref label, so the
    // pinned tier can only display `ab` — it rewrites, but reports a changed
    // display (see the sibling test above, which asserts exactly that for a
    // prose span). On a marked row that display was never rendered in the
    // first place, so the canonical form loses nothing and there is nothing
    // to warn about.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await seedTarget(PIN_TARGET, '', ['a]b'])
      await seedSource('marked', '::[[a]b]]')
      expect(await blockReferences('marked', PIN_TARGET)).toEqual([{alias: 'a]b'}])

      await env.repo.tx(
        tx => tx.setProperty(PIN_TARGET, aliasesProp, []),
        {scope: ChangeScope.BlockDefault},
      )
      await flush()

      expect((await env.read('marked'))!.content).toBe(`::((${PIN_TARGET}))`)
      expect(await blockReferences('marked', PIN_TARGET)).toEqual([{alias: PIN_TARGET}])
      expect(warn.mock.calls.flat().join(' ')).not.toContain('sanitized text')
    } finally {
      warn.mockRestore()
    }
  })

  it('pins an UNMARKED whole-content [[α]] row — only the marker makes it machinery', async () => {
    // The `::` marker is the whole difference. A block whose entire content is
    // a page link is ordinary user content, and its display text is the alias
    // the author typed: `((A))` would render A's CURRENT title instead, which
    // after the release is the new name — silently retitling the user's link.
    // Only a field row has a name of its own to render, which is why it can
    // afford to drop the label.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await seedTarget(PIN_TARGET, '', ['Status'])
      await seedSource('unmarked', '[[Status]]')

      await env.repo.tx(
        tx => tx.setProperty(PIN_TARGET, aliasesProp, []),
        {scope: ChangeScope.BlockDefault},
      )
      await flush()

      expect((await env.read('unmarked'))!.content).toBe(`[Status](((${PIN_TARGET})))`)
      // And it is NOT a field row: the aliased form stamps the target column
      // for any whole-block span, so the bit is the only thing separating the
      // two — assert it, or this passes for the wrong reason.
      expect(await derivedColumns('unmarked'))
        .toEqual({reference_target_id: PIN_TARGET, is_field_form: null})
    } finally {
      warn.mockRestore()
    }
  })

  it('leaves a clean 1-for-1 rename in wikilink form, marked or not', async () => {
    // Liveness for the tier ABOVE the fallback: the marked arm changes the
    // fallback only. A name row follows the living name exactly as a link
    // does — pinning it here would convert every renamed field row to an
    // id-addressed one behind the user's back.
    await seedTarget('t', 'Old', ['Old'])
    await seedSource('marked', '::[[Old]]')

    await env.repo.tx(
      tx => tx.setProperty('t', aliasesProp, ['New']),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    expect((await env.read('marked'))!.content).toBe('::[[New]]')
    expect(await blockReferences('marked', 't')).toEqual([{alias: 'New'}])
  })

  it('leaves a marked row alone when the target is not UUID-shaped', async () => {
    // The canonical form is checked against the INLINE grammar, which is
    // UUID-only — the same grammar that produces the edge the rewriter swaps
    // in lockstep. Emitting `::((t))` would write an entry for an edge no
    // re-parse produces. So the content is left alone and the stale edge is
    // dropped for the re-parse to rebind, exactly as the pinned tier does.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await seedTarget('t', '', ['A'])
      await seedSource('marked', '::[[A]]')
      expect(await blockReferences('marked', 't')).toEqual([{alias: 'A'}])

      await env.repo.tx(
        tx => tx.setProperty('t', aliasesProp, []),
        {scope: ChangeScope.BlockDefault},
      )
      await flush()

      expect((await env.read('marked'))!.content).toBe('::[[A]]')
      expect(await blockReferences('marked', 't')).toEqual([])
      expect(warn.mock.calls.flat().join(' ')).toContain('cannot re-key a marked row')
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

  it('treats a seat minted in the same commit as a real claimant', async () => {
    // A machine seat used to get an EXEMPTION here: post-commit, a
    // re-derive could mint an α-seat in the read→write gap and claim the
    // released name, so the pass had to recognize "a seat my own window
    // produced" and rewrite past it. That recognition was a timestamp
    // heuristic, and every review round found another way to fool it.
    //
    // Same-tx removes the case rather than the guard. Seats are minted by
    // the post-commit `parseReferences`, which runs strictly AFTER this
    // processor, so no seat can appear mid-rename — and a seat that IS
    // live when we look (here: minted by the user's own tx) genuinely owns
    // the name. `[[Win]]` resolves to it, so the span is left as written
    // and only its stale edge is rebound.
    await seedTarget(PIN_TARGET, 'T', ['Win'])
    await seedSource('s', 'see [[Win]] please')

    const seatId = computeAliasSeatId('Win', WS, 0)
    await env.repo.tx(async tx => {
      await tx.setProperty(PIN_TARGET, aliasesProp, [])
      await ensureAliasTarget(tx, env.repo, 'Win', WS)
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    expect((await env.read(seatId))!.content).toBe('Win')
    expect((await env.read('s'))!.content).toBe('see [[Win]] please')
    expect(await refsOf('s')).toEqual([{id: seatId, alias: 'Win'}])
  })
})

describe('applyRefRewrites — surgical entry swap', () => {
  // Runs in the same tx as the content rewrite so the `block_references`
  // trigger refreshes in lockstep; the post-commit parseReferences later
  // re-derives the same list. Asserting it through the processor
  // therefore proves nothing about THIS function — the re-parse produces
  // the right answer either way. The reason it exists is the interval
  // before that re-parse, which a second rename reads.
  const rw = (over: Partial<Rewrite>): Rewrite => Object.assign({
    alias: 'Win',
    replacement: `[Win](((${PIN_TARGET})))`,
    fromTargetId: PIN_TARGET,
    toTargetId: PIN_TARGET,
    refAlias: PIN_TARGET,
    pinned: true,
  } satisfies Rewrite, over)

  it('moves the edge — id and alias together', async () => {
    // A pinned replacement re-parses to a BLOCKREF edge, whose alias is
    // the id. Swapping only the alias would leave the entry naming a
    // target the rewritten content no longer references.
    expect(applyRefRewrites([{id: PIN_TARGET, alias: 'Win'}], [rw({})]))
      .toEqual([{id: PIN_TARGET, alias: PIN_TARGET}])
  })

  it('leaves property-derived edges alone', async () => {
    expect(applyRefRewrites(
      [{id: PIN_TARGET, alias: 'Win', sourceField: 'ref'}],
      [rw({})],
    )).toEqual([{id: PIN_TARGET, alias: 'Win', sourceField: 'ref'}])
  })

  it('leaves an edge alone when its target is not the renaming block', async () => {
    // Another block can share the alias TEXT (sync-applied co-claimants),
    // and its edges are not ours to move.
    const other = '99999999-8888-4777-8666-555555555555'
    expect(applyRefRewrites([{id: other, alias: 'Win'}], [rw({})]))
      .toEqual([{id: other, alias: 'Win'}])
  })

  it('collapses a swap that duplicates an entry the source already had', async () => {
    // `[[α]] → [[β]]` on a source that already said `[[β]]`: two entries
    // become one.
    expect(applyRefRewrites(
      [{id: 't', alias: 'Old'}, {id: 't', alias: 'New'}],
      [rw({alias: 'Old', fromTargetId: 't', toTargetId: 't', refAlias: 'New', pinned: false})],
    )).toEqual([{id: 't', alias: 'New'}])
  })
})

describe('splitBySurvivingSpan — surviving spans keep their edge out of the swap (#444 round 7)', () => {
  // Pinned as a UNIT test on purpose. The processor's write is what
  // schedules `parseReferences`, which re-derives the whole list from
  // content — so an integration assertion always reads the laundered end
  // state and passes whatever this rule does. (Verified: reverting the
  // rule leaves every integration test in this file green.) The interval
  // BEFORE that re-parse is what this protects, and only a direct call
  // can see it.
  const rw = (alias: string, pinned: boolean): Rewrite => ({
    alias,
    replacement: pinned ? `[${alias}](((${PIN_TARGET})))` : `[[${alias}-new]]`,
    fromTargetId: PIN_TARGET,
    toTargetId: PIN_TARGET,
    refAlias: pinned ? PIN_TARGET : `${alias}-new`,
    pinned,
  })

  it('strands an embed-only source: nothing was spliced, so nothing may be swapped', () => {
    // `rewriteWikilinksMulti` returned the content UNCHANGED — the only
    // span was `![[A]]` and the pinned form steps over embeds. Swapping
    // the entry anyway announces a backlink no span in this source
    // supports.
    const {swapped, stranded} = splitBySurvivingSpan([rw('A', true)], '![[A]]')
    expect(swapped).toEqual([])
    expect(stranded.map(r => r.alias)).toEqual(['A'])
  })

  it('strands an alias whose embed survives beside a span that WAS pinned', () => {
    // One normalized entry serves both occurrences, so it cannot describe
    // the pinned span's target and the embed's new binding at once.
    const {swapped, stranded} = splitBySurvivingSpan(
      [rw('A', true)], `see [A](((${PIN_TARGET}))) and ![[A]] too`)
    expect(swapped).toEqual([])
    expect(stranded.map(r => r.alias)).toEqual(['A'])
  })

  it('swaps when every occurrence was replaced', () => {
    // Pinned form, no embed: the parsed alias of `[A](((id)))` is the ID,
    // so `A` is gone from the content and its entry moves normally.
    expect(splitBySurvivingSpan([rw('A', true)], `see [A](((${PIN_TARGET}))) please`))
      .toEqual({swapped: [rw('A', true)], stranded: []})
    // Wikilink form rewrites embeds too (`![[A]]` → `![[A-new]]` is still
    // a page embed), so it strands nothing.
    expect(splitBySurvivingSpan([rw('A', false)], 'see [[A-new]] and ![[A-new]]'))
      .toEqual({swapped: [rw('A', false)], stranded: []})
  })
})

describe('rename — surviving spans converge after the re-parse (#444 round 7)', () => {
  const refsOf = async (id: string) =>
    JSON.parse((await env.read(id))!.references_json) as Array<{id: string; alias: string}>

  it('invalidates the edge of an embed-only source instead of announcing a phantom backlink', async () => {
    // The pinned form deliberately steps over `![[A]]` — spliced under a
    // leading `!` it renders as a markdown image, destroying the display
    // half of the span. So for an embed-ONLY source the content does not
    // change at all. Swapping the entry anyway (what this did before)
    // announced a backlink for a span the content does not contain, while
    // the surviving embed still pointed at the block that gave `A` up.
    // Both wrong: drop the entry and let the re-parse rebind the embed.
    await seedTarget(PIN_TARGET, '', ['A'])
    await seedSource('s', '![[A]]')
    expect(await blockReferences('s', PIN_TARGET)).toEqual([{alias: 'A'}])

    await env.repo.tx(
      tx => tx.setProperty(PIN_TARGET, aliasesProp, []),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    expect((await env.read('s'))!.content).toBe('![[A]]')
    // No phantom edge onto the renamed block, and the embed now binds to
    // whatever `[[A]]` means — a fresh seat.
    expect(await blockReferences('s', PIN_TARGET)).toEqual([])
    expect(await refsOf('s')).toEqual([{id: computeAliasSeatId('A', WS, 0), alias: 'A'}])
  })

  it('drops the shared entry when a pinned rewrite leaves an embed standing beside it', async () => {
    // `normalizeReferences` gives every occurrence of one alias a SINGLE
    // entry, so a source holding both `[[A]]` and `![[A]]` cannot express
    // "the pinned span points at T, the embed points at a seat". Only a
    // re-parse can, so the entry is dropped rather than pointed at either.
    await seedTarget(PIN_TARGET, '', ['A'])
    await seedSource('s', 'see [[A]] and ![[A]] too')

    await env.repo.tx(
      tx => tx.setProperty(PIN_TARGET, aliasesProp, []),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    expect((await env.read('s'))!.content)
      .toBe(`see [A](((${PIN_TARGET}))) and ![[A]] too`)
    // The pinned span binds to the target as a blockref; the embed binds
    // to the seat. Two distinct entries, both rebuilt by the re-parse.
    expect(await refsOf('s')).toEqual(expect.arrayContaining([
      {id: PIN_TARGET, alias: PIN_TARGET},
      {id: computeAliasSeatId('A', WS, 0), alias: 'A'},
    ]))
    expect(await refsOf('s')).toHaveLength(2)
  })
})

describe('rename — derived reference columns (#444 round 8)', () => {
  const stampOf = async (id: string) =>
    (await env.h.db.get<{t: string | null}>(
      `SELECT reference_target_id AS t FROM blocks WHERE id = ?`, [id])).t

  it('leaves an exact-reference source correctly stamped after a handoff', async () => {
    // A whole-content `[[Shared]]` row carries a derived
    // `reference_target_id`, and the handoff branch changes no CONTENT — so
    // rename's own inline recompute (which is gated on a content rewrite)
    // does not run, and `core.deriveReferenceTarget` watches `content`
    // only. The stamp is repaired anyway, INSIDE this tx: dropping the
    // stale edge is a write, which dirties the row, and the kernel's
    // derivation re-run visits dirty rows without filtering on watched
    // fields and re-derives unconditionally. Asserted at commit time,
    // before any post-commit processor can have run, because that is the
    // claim — a post-commit repair would be a different (weaker) one.
    await seedTarget(PIN_TARGET, 'T', ['Shared'])
    await seedTarget('u', 'U', [])
    await seedSource('s', '[[Shared]]')
    // Precondition: it really was stamped at the releasing block, so this
    // cannot pass by the column having been null all along.
    expect(await stampOf('s')).toBe(PIN_TARGET)

    await env.repo.tx(async tx => {
      await tx.setProperty(PIN_TARGET, aliasesProp, [])
      await tx.setProperty('u', aliasesProp, ['Shared'])
    }, {scope: ChangeScope.BlockDefault})

    expect(await stampOf('s')).toBe('u')
    expect((await env.read('s'))!.content).toBe('[[Shared]]')
    await flush()
    expect(await stampOf('s')).toBe('u')
  })
})

describe('rename — pinning a [display]([[alias]]) wikilink (#444 round 8)', () => {
  const refsOf = async (id: string) =>
    JSON.parse((await env.read(id))!.references_json) as Array<{id: string; alias: string}>

  it('rewrites the whole wrapper, keeping the display text and the edge', async () => {
    // `[label]([[A]])` is ONE wikilink to the renderer, with `label` as its
    // display text — `parseReferences` only sees the inner span. Pinning
    // just that span left `[label]([A](((id))))`, a plain markdown link:
    // reference destroyed, stored edge moved to the target anyway.
    await seedTarget(PIN_TARGET, '', ['A'])
    await seedSource('s', 'see [label]([[A]]) please')
    expect(await blockReferences('s', PIN_TARGET)).toEqual([{alias: 'A'}])

    await env.repo.tx(
      tx => tx.setProperty(PIN_TARGET, aliasesProp, []),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    expect((await env.read('s'))!.content).toBe(`see [label](((${PIN_TARGET}))) please`)
    // The span really still binds, as a blockref whose alias is the id.
    expect(await refsOf('s')).toEqual([{id: PIN_TARGET, alias: PIN_TARGET}])
  })

  it('keeps the wrapper shape on a 1-for-1 swap', async () => {
    // The wikilink branch needs no widening: `[label]([[New]])` is the same
    // shape, so the author's display text survives untouched.
    await seedTarget('t', 'Old', ['Old'])
    await seedSource('s', 'see [label]([[Old]]) please')

    await env.repo.tx(
      tx => tx.setProperty('t', aliasesProp, ['New']),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    expect((await env.read('s'))!.content).toBe('see [label]([[New]]) please')
    expect(await refsOf('s')).toEqual([{id: 't', alias: 'New'}])
  })
})

describe('rename — claimants of the released alias (§11 group 2)', () => {
  const refsOf = async (id: string) =>
    JSON.parse((await env.read(id))!.references_json) as Array<{id: string; alias: string}>

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

  it('does not hijack a co-claimant’s backlinks when the other claimant releases the alias', async () => {
    // `block_aliases_workspace_alias_unique` only fires for local user
    // txs, so a SYNC-APPLIED row can co-claim an alias another block
    // already holds (#460). Releasing one of the two changes nothing
    // about where `[[Win]]` points — the other still owns it — so the
    // spans bound to it must be left strictly alone. Following them would
    // re-point every `[[Win]]` onto a block that never owned the name
    // here. A raw insert outside `repo.tx` leaves `tx_context.source`
    // NULL: the same shape a synced row has.
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

    // Untouched: the span still late-binds to the block that owns the name.
    expect((await env.read('s'))!.content).toBe('see [[Win]] please')
    expect(await refsOf('s')).toEqual([{id: seatId, alias: 'Win'}])
    expect((await env.read(seatId))!.deleted).toBe(0)
  })
})
