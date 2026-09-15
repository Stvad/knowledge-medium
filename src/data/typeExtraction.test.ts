// @vitest-environment node

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import { aliasDataExtension } from '@/plugins/alias/dataExtension'
import {
  aliasesProp,
  blockTypeLabelProp,
  blockTypePropertiesProp,
  getBlockTypes,
  typesProp,
} from '@/data/properties'
import { BLOCK_TYPE_TYPE, PAGE_TYPE } from '@/data/blockTypes'
import { BLOCK_TYPE_NAME_CONFLICT } from '@/data/internals/blockTypeTypeifyProcessor'
import {
  GrammarShapedLabelError,
  LossyLabelError,
  MAX_ALIAS_LENGTH,
  UnwritableLabelError,
} from '@/data/referenceBlock'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage'
import { getOrCreateTypesPage, typesPageBlockId } from '@/data/typesPage'
import { Repo } from '@/data/repo'
import {
  TypeRegistrationTimeout,
  createTypeBlock,
  findCandidatesByPropertyShape,
  retagBlocks,
} from '@/data/typeExtraction'

const WS = 'ws-type-extraction'

// `]]` makes the name unwritable as a `[[name]]` link (LossyLabelError).
const LOSSY_NAME = 'Book]]Club'
// A ref-shaped name reads as a block reference rather than a title
// (GrammarShapedLabelError). Built rather than written as one literal
// string — a pre-commit hook rejects a staged uuid-shaped literal.
const GRAMMAR_SHAPED_NAME = '((' + '1'.repeat(8) + '-1111-4111-8111-111111111111))'

interface Harness {
  h: TestDb
  repo: Repo
  dispose: () => void
}

/** `alias: false` drops the alias plugin — the shape a user gets by toggling
 *  Aliases off or opening `?safeMode`, where nothing but the kernel keeps a
 *  type's name claimed. */
const setup = async ({alias = true}: {alias?: boolean} = {}): Promise<Harness> => {
  // Shared DB opened once per file, reset between tests; fresh Repo per test.
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo } = createTestRepo({
    db: h.db,
    user: {id: 'user-1'},
    extensions: [
      kernelPropertyUiExtension,
      kernelValuePresetsExtension,
      // Load the alias plugin so the typeify processor's alias writes are
      // exercised against the REAL content<->alias sync (kernel processor
      // first, then aliasSync) — not in isolation.
      ...(alias ? [aliasDataExtension] : []),
    ],
  })
  repo.setActiveWorkspaceId(WS)
  await getOrCreatePropertiesPage(repo, WS)
  await getOrCreateTypesPage(repo, WS)
  const dispose = (): void => repo.setActiveWorkspaceId(null)
  return {h, repo, dispose}
}

const createBlock = async (env: Harness, content: string, properties: Record<string, unknown> = {}): Promise<string> => {
  const id = await env.repo.mutate.createChild({parentId: env.repo.typesPageId!})
  await env.repo.tx(async tx => {
    const block = await tx.get(id)
    if (!block) throw new Error(`createChild missed: ${id}`)
    await tx.update(id, {
      content,
      properties: {...block.properties, ...properties},
    })
  }, {scope: ChangeScope.BlockDefault})
  return id
}

/** Test-only helper: create a block carrying a refList property AND
 *  the corresponding `references_json` entries (one per target id,
 *  with the same sourceField).
 *
 *  Production keeps `references_json` in sync with refList properties
 *  via `parseReferencesProcessor` (post-commit, in the references
 *  plugin). The kernel-only test harness here doesn't load that
 *  plugin, so refList writes alone wouldn't populate `block_references`
 *  — and the `referencedBy`-based query under test would return nothing.
 *  Writing the references explicitly stands in for the missing
 *  processor. */
const createBlockWithRefs = async (
  env: Harness,
  content: string,
  sourceField: string,
  targetIds: readonly string[],
): Promise<string> => {
  const id = await env.repo.mutate.createChild({parentId: env.repo.typesPageId!})
  await env.repo.tx(async tx => {
    const block = await tx.get(id)
    if (!block) throw new Error(`createChild missed: ${id}`)
    await tx.update(id, {
      content,
      properties: {...block.properties, [sourceField]: targetIds},
      references: targetIds.map(targetId => ({id: targetId, alias: targetId, sourceField})),
    })
  }, {scope: ChangeScope.BlockDefault})
  return id
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
afterEach(() => {
  // Dispose the per-test services; the shared DB is closed once in afterAll.
  // (Each test calls `env = await setup()`, which resets the DB first.)
  env.dispose()
})

// ──── createTypeBlock ───────────────────────────────────────────────

describe('createTypeBlock', () => {
  it('materializes a fresh block-type block on the Types page with label + properties refList', async () => {
    env = await setup()
    const schema = await env.repo.userSchemas.addSchema({name: 'status', presetId: 'string'})
    const schemaBlockId = env.repo.userSchemas.getSchemaBlockId(schema.name)!

    const typeId = await createTypeBlock(env.repo, {
      workspaceId: WS,
      label: 'Task',
      propertySchemaIds: [schemaBlockId],
    })

    const row = await env.repo.load(typeId)
    expect(row).not.toBeNull()
    const types = getBlockTypes(row!)
    expect(types).toContain(BLOCK_TYPE_TYPE)
    expect(types).toContain(PAGE_TYPE)
    expect(row!.properties[blockTypeLabelProp.name]).toBe('Task')
    expect(row!.properties[blockTypePropertiesProp.name]).toEqual([schemaBlockId])
    expect(row!.parentId).toBe(env.repo.typesPageId)
    expect(row!.content).toBe('Task')
    // The type doubles as its `[[Task]]` page — it claims the label as
    // an alias.
    expect(row!.properties[aliasesProp.name]).toEqual(['Task'])
  })

  it('claims the label as an alias so [[label]] resolves to the type block', async () => {
    env = await setup()
    const typeId = await createTypeBlock(env.repo, {
      workspaceId: WS,
      label: 'Task',
      propertySchemaIds: [],
    })

    // The alias index is trigger-maintained; `[[Task]]` resolution
    // (aliasLookup) must land on the type-definition block rather than
    // minting a separate alias-seat page.
    const resolved = await env.repo.query
      .aliasLookup({workspaceId: WS, alias: 'Task'})
      .load()
    expect(resolved?.id).toBe(typeId)
  })

  it('rejects when the label collides with an existing page alias', async () => {
    env = await setup()
    // A prior `[[Task]]` reference (or create-page UI) already left a
    // live block claiming the alias in this workspace.
    await claimAlias(env, 'Task')

    await expect(createTypeBlock(env.repo, {
      workspaceId: WS,
      label: 'Task',
      propertySchemaIds: [],
    })).rejects.toMatchObject({code: 'alias.collision'})
  })

  it('returns a typeId that is registered in repo.types by the time the promise resolves', async () => {
    env = await setup()
    const typeId = await createTypeBlock(env.repo, {
      workspaceId: WS,
      label: 'Task',
      propertySchemaIds: [],
    })
    expect(env.repo.types.has(typeId)).toBe(true)
    expect(env.repo.types.get(typeId)?.label).toBe('Task')
  })

  it('returns distinct ids on repeat calls (no in-place collision)', async () => {
    env = await setup()
    // Distinct labels: each type claims its label as a workspace-unique
    // alias, so two same-named types can't coexist (covered separately).
    // The property under test is that repeat calls mint fresh block ids
    // rather than reusing a deterministic one.
    const a = await createTypeBlock(env.repo, {workspaceId: WS, label: 'Task', propertySchemaIds: []})
    const b = await createTypeBlock(env.repo, {workspaceId: WS, label: 'Project', propertySchemaIds: []})
    expect(a).not.toBe(b)
    expect(env.repo.types.has(a)).toBe(true)
    expect(env.repo.types.has(b)).toBe(true)
  })

  // Name hygiene (docs/properties-as-blocks-migration.html §7): the label is written as the definition
  // block's own content, so a reference-shaped one would mint a block that
  // reads as a span — `::`-marked, a recognized property field row of the
  // Types page, hidden from the outline and keyed onto its cell.
  it.each([
    ['a marked exact ref', '::((0f7b3c1a-9d2e-4f60-8a1b-2c3d4e5f6a7b))'],
    ['a bare exact ref', '((0f7b3c1a-9d2e-4f60-8a1b-2c3d4e5f6a7b))'],
    ['a wikilink', '[[Person]]'],
  ])('refuses %s as a label', async (_case, label) => {
    env = await setup()
    await expect(createTypeBlock(env.repo, {
      workspaceId: WS, label, propertySchemaIds: [],
    })).rejects.toThrow(/reads as a block reference/)
  })

  it('throws when label is blank', async () => {
    env = await setup()
    await expect(createTypeBlock(env.repo, {
      workspaceId: WS,
      label: '   ',
      propertySchemaIds: [],
    })).rejects.toThrow(/label must be a non-empty string/)
  })

  it('throws when a propertySchemaId does not resolve to a live block', async () => {
    env = await setup()
    await expect(createTypeBlock(env.repo, {
      workspaceId: WS,
      label: 'Task',
      propertySchemaIds: ['nonexistent-schema'],
    })).rejects.toThrow(/doesn't resolve to a live block/)
  })

  it('honors an aborted signal pre-flight', async () => {
    env = await setup()
    const controller = new AbortController()
    controller.abort()
    // throwIfAborted() rejects with signal.reason — an AbortError
    // DOMException. Pin the abort contract so a swap to some unrelated
    // error (or a rejection with undefined) is caught.
    await expect(createTypeBlock(env.repo, {
      workspaceId: WS,
      label: 'Task',
      propertySchemaIds: [],
      signal: controller.signal,
    })).rejects.toMatchObject({name: 'AbortError'})
  })

  it('TypeRegistrationTimeout has the expected shape', () => {
    const err = new TypeRegistrationTimeout('type-id', 'Task', 1500)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('TypeRegistrationTimeout')
    expect(err.typeBlockId).toBe('type-id')
    expect(err.typeLabel).toBe('Task')
    expect(err.timeoutMs).toBe(1500)
    expect(err.message).toContain('did not appear in the runtime registry within 1500ms')
  })

  it('parents under args.workspaceId\'s Types page, not the active workspace', async () => {
    // Guard against the regression where createTypeBlock used
    // `repo.typesPageId` (derived from `activeWorkspaceId`) instead of
    // `args.workspaceId`. With only `WS` bootstrapped, asking for a
    // type in some other workspace must surface the missing-Types-page
    // error rather than silently parenting under WS.
    env = await setup()
    await expect(createTypeBlock(env.repo, {
      workspaceId: 'ws-other-no-bootstrap',
      label: 'Task',
      propertySchemaIds: [],
    })).rejects.toThrow(/no Types page for workspace ws-other-no-bootstrap/)
  })
})

// ──── block-type typeify processor ──────────────────────────────────

/** Plant a cell the codec refuses, in the shape only a sync-applied or
 *  pre-upgrade row has: a raw write maintains the trigger-backed indexes
 *  (`block_aliases` included) and fires no processor. */
const rawProperties = async (
  env: Harness,
  id: string,
  properties: Record<string, unknown>,
  content?: string,
): Promise<void> => {
  await env.h.db.writeTransaction(async tx => {
    await tx.execute(
      content === undefined
        ? 'UPDATE blocks SET properties_json = ? WHERE id = ?'
        : 'UPDATE blocks SET properties_json = ?, content = ? WHERE id = ?',
      content === undefined
        ? [JSON.stringify(properties), id]
        : [JSON.stringify(properties), content, id],
    )
  })
}

const rawPropertiesOf = async (env: Harness, id: string): Promise<Record<string, unknown>> => {
  const row = await env.h.db.getOptional<{properties_json: string}>(
    'SELECT properties_json FROM blocks WHERE id = ?', [id])
  return JSON.parse(row!.properties_json) as Record<string, unknown>
}

/** Plant an alias cell the codec refuses, leaving the rest of the bag as the
 *  tagging path wrote it. */
const rawAliasCell = async (env: Harness, id: string, cell: unknown): Promise<void> =>
  rawProperties(env, id, {...await rawPropertiesOf(env, id), [aliasesProp.name]: cell})

/** Another block already holding `name` — the collision every refusal test
 *  needs on the other side. */
const claimAlias = async (env: Harness, name: string): Promise<string> => {
  const id = await env.repo.mutate.createChild({parentId: env.repo.typesPageId!})
  await env.repo.tx(async tx => {
    await tx.update(id, {content: name})
    await tx.setProperty(id, aliasesProp, [name])
  }, {scope: ChangeScope.BlockDefault})
  return id
}

/** Tag a fresh block `block-type` — the state EVERY tagging path lands
 *  in (`#type`, the picker, programmatic, import). The kernel
 *  `blockTypeTypeify` same-tx processor completes it in this same tx:
 *  adopt content→label, add PAGE_TYPE, claim the label alias. */
const tagBlockType = async (
  env: Harness,
  content: string,
  extraProps: Record<string, unknown> = {},
): Promise<string> => {
  const id = await env.repo.mutate.createChild({parentId: env.repo.typesPageId!})
  await env.repo.tx(async tx => {
    await tx.update(id, {content, properties: extraProps})
    await env.repo.addTypeInTx(tx, id, BLOCK_TYPE_TYPE, {}, env.repo.snapshotTypeRegistries())
  }, {scope: ChangeScope.BlockDefault})
  return id
}

describe('block-type typeify processor', () => {
  it('adopts content as the label, tags PAGE_TYPE, and claims the alias', async () => {
    env = await setup()
    const id = await tagBlockType(env, 'Book')

    const row = await env.repo.load(id)
    expect(row!.properties[blockTypeLabelProp.name]).toBe('Book')
    expect(getBlockTypes(row!)).toContain(PAGE_TYPE)
    expect(row!.properties[aliasesProp.name]).toEqual(['Book'])
    // `[[Book]]` resolves to this block, not a duplicate seat.
    const resolved = await env.repo.query.aliasLookup({workspaceId: WS, alias: 'Book'}).load()
    expect(resolved?.id).toBe(id)
  })

  // This processor adopts whatever content the block already had as the
  // type's name and claims it as an alias, and it fires on ANY path that
  // adds `block-type` — including the agent bridge's raw properties bag,
  // which validates nothing. A type whose name can't be written as
  // `[[name]]` is broken in the way that matters (nothing can link to
  // it), so the tagging is REFUSED rather than quietly producing one.
  it.each([
    ['`]]`-lossy', LOSSY_NAME, LossyLabelError],
    ['past the alias cap', 'a'.repeat(MAX_ALIAS_LENGTH + 1), LossyLabelError],
    ['grammar-shaped', GRAMMAR_SHAPED_NAME, GrammarShapedLabelError],
  ])('refuses to type-tag a block whose name is %s', async (_label, content, errorType) => {
    env = await setup()
    await expect(tagBlockType(env, content)).rejects.toThrow(errorType)
  })

  it('refuses a tag whose content and explicit label are different names', async () => {
    env = await setup()
    await expect(tagBlockType(env, 'notes about books', {
      [blockTypeLabelProp.name]: 'Book',
    })).rejects.toMatchObject({code: BLOCK_TYPE_NAME_CONFLICT})
  })

  // Both processors claim within the one tagging tx — typeify claims the
  // label, then aliasSync's additive heal appends the changed content — so
  // "refused" has to mean neither name is left claimed, not merely that
  // the tx threw.
  it('claims neither name when the two disagree', async () => {
    env = await setup()
    const id = await env.repo.mutate.createChild({parentId: env.repo.typesPageId!})
    await expect(env.repo.tx(async tx => {
      await tx.update(id, {
        content: 'notes about books',
        properties: {[blockTypeLabelProp.name]: 'Book'},
      })
      await env.repo.addTypeInTx(tx, id, BLOCK_TYPE_TYPE, {}, env.repo.snapshotTypeRegistries())
    }, {scope: ChangeScope.BlockDefault})).rejects.toMatchObject({code: BLOCK_TYPE_NAME_CONFLICT})

    const row = await env.repo.load(id)
    expect(getBlockTypes(row!)).not.toContain(BLOCK_TYPE_TYPE)
    expect(row!.properties[aliasesProp.name] ?? []).toEqual([])
    for (const alias of ['Book', 'notes about books']) {
      expect(await env.repo.query.aliasLookup({workspaceId: WS, alias}).load()).toBeNull()
    }
  })

  // Grammar-shaped content on a type block is the dangerous residue:
  // `core.deriveReferenceTarget` stamps the row as a field form, and on a
  // child-backed page the type then projects as property machinery instead
  // of appearing in the outline. The name-conflict refusal covers it.
  it('refuses when an explicit label hides grammar-shaped content', async () => {
    env = await setup()
    await expect(tagBlockType(env, '::((11111111-1111-4111-8111-111111111111))', {
      [blockTypeLabelProp.name]: 'Book',
    })).rejects.toMatchObject({code: BLOCK_TYPE_NAME_CONFLICT})
  })

  // The label is hygiene-checked in its own right, and BEFORE the conflict
  // check — for a doubly-bad tag the unwritable name is the more useful
  // diagnosis, and it is the one the `#type` UI knows how to revert.
  it('refuses an unwritable explicit label ahead of the content conflict', async () => {
    env = await setup()
    await expect(tagBlockType(env, 'notes about books', {
      [blockTypeLabelProp.name]: 'Book]]Club',
    })).rejects.toThrow(LossyLabelError)
  })

  // A PADDED label diverges from its own trimmed alias, so the strand needs
  // no exotic fixture — content is aligned to the trimmed name the alias
  // actually carries.
  it('aligns content with a padded label, so a rename replaces the alias', async () => {
    env = await setup()
    const id = await tagBlockType(env, ' Padded ', {[blockTypeLabelProp.name]: ' Padded '})
    let row = await env.repo.load(id)
    expect(row!.content).toBe('Padded')
    expect(row!.properties[aliasesProp.name]).toEqual(['Padded'])

    await env.repo.tx(async tx => {
      await tx.setProperty(id, blockTypeLabelProp, 'Gadget')
      await tx.update(id, {content: 'Gadget'})
    }, {scope: ChangeScope.BlockDefault})
    row = await env.repo.load(id)
    expect(row!.properties[aliasesProp.name]).toEqual(['Gadget'])
  })

  // Blank (or whitespace-only) content has no second name in it, so the
  // label is adopted into content instead of refused — lossless, and it
  // restores the content == label == alias parity a later rename needs.
  it.each([['blank', ''], ['whitespace-only', '   ']])(
    'adopts an explicit label into %s content, so a rename replaces the alias',
    async (_l, content) => {
      env = await setup()
      const id = await tagBlockType(env, content, {[blockTypeLabelProp.name]: 'Book'})
      let row = await env.repo.load(id)
      expect(row!.content).toBe('Book')
      expect(row!.properties[aliasesProp.name]).toEqual(['Book'])

      // The rename shape `writeBlockTypeLabel` writes; without the adoption
      // above, aliasSync appends and strands 'Book'.
      await env.repo.tx(async tx => {
        await tx.setProperty(id, blockTypeLabelProp, 'Novel')
        await tx.update(id, {content: 'Novel'})
      }, {scope: ChangeScope.BlockDefault})
      row = await env.repo.load(id)
      expect(row!.properties[aliasesProp.name]).toEqual(['Novel'])
      expect(await env.repo.query.aliasLookup({workspaceId: WS, alias: 'Book'}).load()).toBeNull()
    })

  // The refusal is atomic: the tag doesn't half-apply. Same-tx, so the
  // PAGE_TYPE / label writes above the assert roll back with it.
  it('leaves the block untouched when the name is refused', async () => {
    env = await setup()
    const id = await env.repo.mutate.createChild({parentId: env.repo.typesPageId!})
    await env.repo.tx(
      tx => tx.update(id, {content: 'Book]]Club'}),
      {scope: ChangeScope.BlockDefault},
    )

    await expect(env.repo.tx(async tx => {
      await env.repo.addTypeInTx(tx, id, BLOCK_TYPE_TYPE, {}, env.repo.snapshotTypeRegistries())
    }, {scope: ChangeScope.BlockDefault})).rejects.toThrow(LossyLabelError)

    const row = await env.repo.load(id)
    expect(getBlockTypes(row!)).not.toContain(BLOCK_TYPE_TYPE)
    expect(getBlockTypes(row!)).not.toContain(PAGE_TYPE)
    expect(row!.properties[aliasesProp.name] ?? []).toEqual([])
  })

  it('trims whitespace-padded adopted content so a later rename replaces the alias', async () => {
    env = await setup()
    // `#type` on '  Book  ' adopts the name 'Book' but must also trim the
    // stored content — otherwise content ('  Book  ') and alias ('Book')
    // diverge, and aliasSync (which matches aliases by content) can't
    // replace the alias on rename, stranding the old name.
    const id = await tagBlockType(env, '  Book  ')
    let row = await env.repo.load(id)
    expect(row!.content).toBe('Book')
    expect(row!.properties[blockTypeLabelProp.name]).toBe('Book')
    expect(row!.properties[aliasesProp.name]).toEqual(['Book'])

    // Rename to 'Novel' — aliasSync replaces the old-content alias in
    // place; without the content trim above it would append and strand
    // 'Book'.
    await env.repo.tx(async tx => {
      await tx.setProperty(id, blockTypeLabelProp, 'Novel')
      await tx.update(id, {content: 'Novel'})
    }, {scope: ChangeScope.BlockDefault})
    row = await env.repo.load(id)
    expect(row!.properties[aliasesProp.name]).toEqual(['Novel'])
  })

  it('claims the type name even when the block already carries another alias', async () => {
    // Regression: an only-if-empty gate left the type name unclaimed when
    // the block held any other alias, so `[[Book]]` minted a duplicate
    // seat. Ensure-present appends the name to the existing set instead.
    env = await setup()
    const id = await tagBlockType(env, 'Book', {[aliasesProp.name]: ['MyNote']})

    const row = await env.repo.load(id)
    expect(row!.properties[aliasesProp.name]).toEqual(['MyNote', 'Book'])
    const resolved = await env.repo.query.aliasLookup({workspaceId: WS, alias: 'Book'}).load()
    expect(resolved?.id).toBe(id)
  })

  it('is idempotent — re-tagging block-type does not clobber or duplicate', async () => {
    env = await setup()
    const id = await tagBlockType(env, 'Book')
    await env.repo.tx(async tx => {
      await env.repo.addTypeInTx(tx, id, BLOCK_TYPE_TYPE, {}, env.repo.snapshotTypeRegistries())
    }, {scope: ChangeScope.BlockDefault})

    const row = await env.repo.load(id)
    expect(row!.properties[blockTypeLabelProp.name]).toBe('Book')
    expect(row!.properties[aliasesProp.name]).toEqual(['Book'])
    expect(getBlockTypes(row!).filter(t => t === PAGE_TYPE)).toHaveLength(1)
  })

  it('never overwrites an explicitly-set label/alias (createTypeBlock-style)', async () => {
    env = await setup()
    // A createTypeBlock-style row: content == label == alias, all set
    // explicitly. The processor must leave label and alias untouched.
    const id = await tagBlockType(env, 'Custom', {
      [blockTypeLabelProp.name]: 'Custom',
      [aliasesProp.name]: ['Custom'],
    })

    const row = await env.repo.load(id)
    expect(row!.properties[blockTypeLabelProp.name]).toBe('Custom')
    expect(row!.properties[aliasesProp.name]).toEqual(['Custom'])
  })

  it('does not grow the alias set on a later label-only edit', async () => {
    env = await setup()
    const id = await tagBlockType(env, 'Book')
    // The completion's ensure-present claim belongs to the type-add alone.
    // Were it to run again here it would append 'Novel' → alias grows, and
    // the block would answer to two names. aliasSync stays out of it
    // (content unchanged), so this isolates the completion.
    await env.repo.tx(async tx => {
      await tx.setProperty(id, blockTypeLabelProp, 'Novel')
    }, {scope: ChangeScope.BlockDefault})

    const row = await env.repo.load(id)
    expect(row!.properties[aliasesProp.name]).toEqual(['Book'])
  })

  // A content rewrite on a block that is ALREADY a type — the agent bridge,
  // an import — is a RENAME: aliasSync already moves the alias to the new
  // content, so the label has to move with it or the type stays registered
  // under a name nothing resolves to.
  it('follows a content rewrite on an existing type with its label and alias', async () => {
    env = await setup()
    const id = await tagBlockType(env, 'Book')

    await env.repo.tx(
      tx => tx.update(id, {content: 'Novel'}),
      {scope: ChangeScope.BlockDefault},
    )

    const row = await env.repo.load(id)
    expect(row!.properties[blockTypeLabelProp.name]).toBe('Novel')
    expect(row!.properties[aliasesProp.name]).toEqual(['Novel'])
    expect((await env.repo.query.aliasLookup({workspaceId: WS, alias: 'Novel'}).load())?.id).toBe(id)
    expect(await env.repo.query.aliasLookup({workspaceId: WS, alias: 'Book'}).load()).toBeNull()
  })

  // Emptying the body is not a rename: a blank label DROPS the type from the
  // registry while aliasSync's blank-content guard keeps the claim, so the
  // name would survive with nothing left to publish it.
  it('keeps a type named when its content is cleared', async () => {
    env = await setup()
    const id = await tagBlockType(env, 'Book')

    await env.repo.tx(
      tx => tx.update(id, {content: '   '}),
      {scope: ChangeScope.BlockDefault},
    )

    const row = await env.repo.load(id)
    expect(row!.properties[blockTypeLabelProp.name]).toBe('Book')
    expect((await env.repo.query.aliasLookup({workspaceId: WS, alias: 'Book'}).load())?.id).toBe(id)
  })

  // Same rule as the tag path, one tx later — a name that can't be written
  // as `[[name]]` leaves the type unlinkable, so the rename is refused whole
  // instead of propagated into a label nothing can address.
  it.each([
    ['`]]`-lossy', LOSSY_NAME, LossyLabelError],
    ['grammar-shaped', GRAMMAR_SHAPED_NAME, GrammarShapedLabelError],
  ])('refuses a content rewrite renaming a type to a name that is %s', async (_l, content, errorType) => {
    env = await setup()
    const id = await tagBlockType(env, 'Book')

    await expect(env.repo.tx(
      tx => tx.update(id, {content}),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toThrow(errorType)

    const row = await env.repo.load(id)
    expect(row!.content).toBe('Book')
    expect(row!.properties[aliasesProp.name]).toEqual(['Book'])
  })

  // A type tagged blank claims no alias, and aliasSync only reconciles
  // blocks that already carry one — so nothing else would claim the name
  // the registry is about to publish.
  it('claims the name when content arrives on a type tagged blank', async () => {
    env = await setup()
    const id = await tagBlockType(env, '   ')

    await env.repo.tx(
      tx => tx.update(id, {content: 'Widget'}),
      {scope: ChangeScope.BlockDefault},
    )

    const row = await env.repo.load(id)
    expect(row!.properties[blockTypeLabelProp.name]).toBe('Widget')
    expect((await env.repo.query.aliasLookup({workspaceId: WS, alias: 'Widget'}).load())?.id).toBe(id)
  })

  // A type that was never named has no name to keep, so an emptied body stays
  // empty — and claims nothing.
  it('accepts a blank body on a type that was never named', async () => {
    env = await setup()
    const id = await tagBlockType(env, '   ')

    await env.repo.tx(
      tx => tx.update(id, {content: ''}),
      {scope: ChangeScope.BlockDefault},
    )

    const row = await env.repo.load(id)
    expect(row!.content).toBe('')
    expect(row!.properties[blockTypeLabelProp.name]).toBeUndefined()
    expect(row!.properties[aliasesProp.name]).toBeUndefined()
  })

  // The kernel claims the new name itself, so the invariant survives the alias
  // plugin being toggled off — but a name another block holds is left alone.
  // This pins that the refusal happens in the alias plugin's PREFLIGHT, not at
  // the uniqueness trigger a step later: only the preflight's rejection carries
  // `dropSourceAliases` / `collisionOrigin`, so firing a step later would lose
  // the metadata the merge offer is built from.
  it('refuses a colliding rename in the preflight, so the merge offer survives', async () => {
    env = await setup()
    const id = await tagBlockType(env, 'Book')
    await claimAlias(env, 'Novel')

    await expect(env.repo.tx(
      tx => tx.update(id, {content: 'Novel'}),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toMatchObject({
      code: 'alias.collision',
      meta: {collisionOrigin: 'content-rename', dropSourceAliases: ['Book']},
    })
  })

  // The gate reads `types` on every content edit in the workspace now, so a
  // cell the codec refuses must not cost an ordinary block its edit.
  it('lets a block with a malformed types cell keep editing its content', async () => {
    env = await setup()
    const id = await createBlock(env, 'Ordinary')
    await rawProperties(env, id, {types: 'block-type'})

    await expect(env.repo.tx(
      tx => tx.update(id, {content: 'Ordinary, edited'}),
      {scope: ChangeScope.BlockDefault},
    )).resolves.toBeUndefined()

    const row = await env.repo.load(id)
    expect(row!.content).toBe('Ordinary, edited')
    expect(row!.properties[blockTypeLabelProp.name]).toBeUndefined()
  })

  // The alias TRIGGER indexes every text entry, so 'Book' resolves here even
  // though the bag as a whole is undecodable. Rebuilding that bag from the
  // decoded value would release it.
  it('keeps the entries the alias index honours when renaming past a malformed bag', async () => {
    env = await setup()
    const id = await tagBlockType(env, 'Book')
    await rawAliasCell(env, id, ['Book', 7, 'Other'])

    await env.repo.tx(
      tx => tx.update(id, {content: 'Novel'}),
      {scope: ChangeScope.BlockDefault},
    )

    // Nothing the stored bag could not show is retired — not by the kernel and
    // not by the plugin — because no reader of a rename could see it go. So
    // the repaired bag keeps both old names and gains the new one, and this is
    // the SAME answer the plugin-off case gives below.
    expect((await rawPropertiesOf(env, id))[aliasesProp.name]).toEqual(['Book', 'Other', 'Novel'])
    for (const alias of ['Book', 'Other', 'Novel']) {
      expect((await env.repo.query.aliasLookup({workspaceId: WS, alias}).load())?.id).toBe(id)
    }
  })

  // The alias index doesn't care about SHAPE — a scalar cell indexes its text
  // just as a one-element list does (`json_each` yields the scalar itself),
  // and an object cell indexes the text values nested inside it — so a rename
  // that reads either as "no claims" (because the bag doesn't decode)
  // publishes a name nothing resolves to.
  it.each([
    ['scalar', 'Book'],
    ['object-shaped', {primary: 'Book'}],
  ])('claims the new name past a %s alias cell', async (_shape, cell) => {
    env = await setup()
    const id = await tagBlockType(env, 'Book')
    await rawAliasCell(env, id, cell)
    // The precondition: the trigger really did index the cell.
    expect((await env.repo.query.aliasLookup({workspaceId: WS, alias: 'Book'}).load())?.id).toBe(id)

    await env.repo.tx(
      tx => tx.update(id, {content: 'Novel'}),
      {scope: ChangeScope.BlockDefault},
    )

    expect((await env.repo.query.aliasLookup({workspaceId: WS, alias: 'Novel'}).load())?.id).toBe(id)
    // And the old name still resolves: the bag never showed it, so nothing may
    // retire it — the plugin included.
    expect((await env.repo.query.aliasLookup({workspaceId: WS, alias: 'Book'}).load())?.id).toBe(id)
  })

  // A3: the old content was never an alias anchor, so the rename retires
  // nothing — and the merge offer must not be told to drop a title this block
  // does not hold, or accepting it would strand that name.
  it('offers no dropped alias when the old content was never claimed', async () => {
    env = await setup()
    const id = await tagBlockType(env, 'Book')
    await rawAliasCell(env, id, ['Other'])
    await claimAlias(env, 'Novel')

    await expect(env.repo.tx(
      tx => tx.update(id, {content: 'Novel'}),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toMatchObject({
      code: 'alias.collision',
      meta: {dropSourceAliases: [], collisionOrigin: 'content-rename'},
    })
  })

  // Every write on this path reconciles somebody else's change, so a DERIVED
  // content rewrite must not float the type into recents.
  it('does not stamp the type as user-touched when the rename is derived', async () => {
    env = await setup()
    const id = await tagBlockType(env, 'Book')
    const stampOf = async (): Promise<number> => {
      const row = await env.h.db.getOptional<{user_updated_at: number}>(
        'SELECT user_updated_at FROM blocks WHERE id = ?', [id])
      return row!.user_updated_at
    }
    const before = await stampOf()

    await env.repo.tx(
      tx => tx.update(id, {content: 'Novel'}, {skipMetadata: true}),
      {scope: ChangeScope.BlockDefault},
    )

    expect(await env.repo.load(id).then(r => r!.properties[blockTypeLabelProp.name])).toBe('Novel')
    expect(await stampOf()).toBe(before)
  })

  // A legacy or sync-applied type can be titled `See [[Foo]]`, which the tag
  // path would refuse today. Renaming Foo rewrites that title in the RENAME's
  // own tx (`references.renameBacklinks`), and this processor sees it on the
  // rerun: refusing there would roll back an unrelated rename for good, and
  // declining to reconcile would strand the label while the claim moved.
  it('reconciles a rewrite of an already-unwritable type name', async () => {
    env = await setup()
    const id = await tagBlockType(env, 'Book')
    await rawProperties(env, id, {
      types: [BLOCK_TYPE_TYPE, PAGE_TYPE],
      [blockTypeLabelProp.name]: 'See [[Foo]]',
      [aliasesProp.name]: ['See [[Foo]]'],
    }, 'See [[Foo]]')

    await expect(env.repo.tx(
      tx => tx.update(id, {content: 'See [[Bar]]'}),
      {scope: ChangeScope.BlockDefault},
    )).resolves.toBeUndefined()

    const row = await env.repo.load(id)
    expect(row!.content).toBe('See [[Bar]]')
    // Still unlinkable — that is the row's pre-existing condition, and not
    // something an unrelated rename gets to pay for. What this path can do is
    // keep the three spellings saying the same thing.
    expect(row!.properties[blockTypeLabelProp.name]).toBe('See [[Bar]]')
    expect(row!.properties[aliasesProp.name]).toEqual(['See [[Bar]]'])
  })

  // A type tagged blank is UNNAMED, not broken: the first name it is given is
  // a new name and gets the check the tag path would have given it.
  it.each([
    ['`]]`-lossy', LOSSY_NAME],
    ['grammar-shaped', GRAMMAR_SHAPED_NAME],
  ])('refuses a first name that is %s on a type tagged blank', async (_l, content) => {
    env = await setup()
    const id = await tagBlockType(env, '   ')

    await expect(env.repo.tx(
      tx => tx.update(id, {content}),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toThrow(UnwritableLabelError)

    const row = await env.repo.load(id)
    expect(row!.properties[blockTypeLabelProp.name]).toBeUndefined()
    expect(row!.properties[aliasesProp.name]).toBeUndefined()
  })

  // The transition is read on BOTH sides, so a tx that writes a well-formed
  // `types` cell over a malformed one completes the type instead of throwing
  // the codec error out of the pass.
  it('types a block whose previous types cell was malformed', async () => {
    env = await setup()
    const id = await createBlock(env, 'Widget')
    await rawProperties(env, id, {types: 'block-type'})

    await expect(env.repo.tx(
      tx => tx.update(id, {properties: {types: [BLOCK_TYPE_TYPE]}}),
      {scope: ChangeScope.BlockDefault},
    )).resolves.toBeUndefined()

    const row = await env.repo.load(id)
    expect(row!.properties[blockTypeLabelProp.name]).toBe('Widget')
    expect((await env.repo.query.aliasLookup({workspaceId: WS, alias: 'Widget'}).load())?.id).toBe(id)
  })

  // A legacy row can have a WORKING label over an unwritable body. Retitling
  // that body — again, inside somebody else's rename — must neither roll that
  // rename back nor take the name the registry publishes away from this type.
  it('keeps a working label when an unwritable body is rewritten', async () => {
    env = await setup()
    const id = await tagBlockType(env, 'Book')
    await rawProperties(env, id, {
      types: [BLOCK_TYPE_TYPE, PAGE_TYPE],
      [blockTypeLabelProp.name]: 'Book',
      [aliasesProp.name]: ['Book'],
    }, 'See [[Foo]]')

    await expect(env.repo.tx(
      tx => tx.update(id, {content: 'See [[Bar]]'}),
      {scope: ChangeScope.BlockDefault},
    )).resolves.toBeUndefined()

    const row = await env.repo.load(id)
    expect(row!.properties[blockTypeLabelProp.name]).toBe('Book')
    expect((await env.repo.query.aliasLookup({workspaceId: WS, alias: 'Book'}).load())?.id).toBe(id)
  })

  // Padding is not a different name: a legacy row storing `" Book "` as its
  // content claimed `Book`, and a rename retires the claim it actually made.
  it('retires a padded old name on rename', async () => {
    env = await setup()
    const id = await tagBlockType(env, 'Book')
    await rawProperties(env, id, {
      types: [BLOCK_TYPE_TYPE, PAGE_TYPE],
      [blockTypeLabelProp.name]: 'Book',
      [aliasesProp.name]: ['Book'],
    }, ' Book ')

    await env.repo.tx(
      tx => tx.update(id, {content: 'Novel'}),
      {scope: ChangeScope.BlockDefault},
    )

    expect((await rawPropertiesOf(env, id))[aliasesProp.name]).toEqual(['Novel'])
    expect(await env.repo.query.aliasLookup({workspaceId: WS, alias: 'Book'}).load()).toBeNull()
  })

  it('leaves an ordinary block alone when its content changes', async () => {
    env = await setup()
    const id = await createBlock(env, 'Just a block')

    await env.repo.tx(
      tx => tx.update(id, {content: 'Still just a block'}),
      {scope: ChangeScope.BlockDefault},
    )

    const row = await env.repo.load(id)
    expect(row!.properties[blockTypeLabelProp.name]).toBeUndefined()
  })

  it('leaves a blank block unnamed (no label/alias) but still a page', async () => {
    env = await setup()
    const id = await tagBlockType(env, '   ')

    const row = await env.repo.load(id)
    expect(row!.properties[blockTypeLabelProp.name]).toBeUndefined()
    expect(row!.properties[aliasesProp.name]).toBeUndefined()
    expect(getBlockTypes(row!)).toContain(PAGE_TYPE)
  })

  it('rejects when the adopted name collides with an existing page alias', async () => {
    env = await setup()
    await claimAlias(env, 'Book')

    await expect(tagBlockType(env, 'Book')).rejects.toMatchObject({code: 'alias.collision'})
  })

  describe('with the alias plugin off', () => {
    it('claims the renamed name with the alias plugin absent', async () => {
      env = await setup({alias: false})
      const id = await tagBlockType(env, 'Book')

      await env.repo.tx(
        tx => tx.update(id, {content: 'Novel'}),
        {scope: ChangeScope.BlockDefault},
      )

      const row = await env.repo.load(id)
      expect(row!.properties[blockTypeLabelProp.name]).toBe('Novel')
      expect((await env.repo.query.aliasLookup({workspaceId: WS, alias: 'Novel'}).load())?.id).toBe(id)
      // The rename RETIRES the old name here too: with no plugin to do it, an
      // append-only claim would leave the type answering to both names forever.
      expect(await env.repo.query.aliasLookup({workspaceId: WS, alias: 'Book'}).load()).toBeNull()
    })

    it('refuses a rename onto a taken name with the alias plugin absent', async () => {
      env = await setup({alias: false})
      const id = await tagBlockType(env, 'Book')
      await claimAlias(env, 'Novel')

      // Nothing else would: committing the label while skipping the claim is the
      // unlinkable type this path exists to prevent.
      await expect(env.repo.tx(
        tx => tx.update(id, {content: 'Novel'}),
        {scope: ChangeScope.BlockDefault},
      )).rejects.toMatchObject({code: 'alias.collision'})

      const row = await env.repo.load(id)
      expect(row!.properties[blockTypeLabelProp.name]).toBe('Book')
    })

    // What the rename RETIRES has to be visible in the stored bag, because that
    // is what every other reactor diffs — `references.renameBacklinks` reads the
    // bag, so a claim released from the index alone takes its inbound links with
    // it and nothing rewrites them. Keeping it costs a type that answers to two
    // names; releasing it costs the links.
    it('keeps a claim the stored bag cannot show when renaming', async () => {
      env = await setup({alias: false})
      const id = await tagBlockType(env, 'Book')
      await rawAliasCell(env, id, ['Book', 7])

      await env.repo.tx(
        tx => tx.update(id, {content: 'Novel'}),
        {scope: ChangeScope.BlockDefault},
      )

      expect((await env.repo.query.aliasLookup({workspaceId: WS, alias: 'Novel'}).load())?.id).toBe(id)
      expect((await env.repo.query.aliasLookup({workspaceId: WS, alias: 'Book'}).load())?.id).toBe(id)
    })

    // A rewrite of an already-unwritable name must not take an unrelated tx down
    // with it, and refusing a COLLISION is a refusal like any other: the name
    // nothing can link to is not claimed, so there is nothing to collide. Plugin
    // off, because the reachable shape is a LATE rewrite — `renameBacklinks`
    // retitling this type inside someone else's rename, after `alias.sync` has
    // already run — and only the kernel's rerun acts there.
    it('commits a legacy rewrite even when the new spelling is claimed elsewhere', async () => {
      env = await setup({alias: false})
      const id = await tagBlockType(env, 'Book')
      await rawProperties(env, id, {
        types: [BLOCK_TYPE_TYPE, PAGE_TYPE],
        [blockTypeLabelProp.name]: 'See [[Foo]]',
        [aliasesProp.name]: ['See [[Foo]]'],
      }, 'See [[Foo]]')
      const squatter = await claimAlias(env, 'See [[Bar]]')

      await expect(env.repo.tx(
        tx => tx.update(id, {content: 'See [[Bar]]'}),
        {scope: ChangeScope.BlockDefault},
      )).resolves.toBeUndefined()

      const row = await env.repo.load(id)
      expect(row!.content).toBe('See [[Bar]]')
      expect(row!.properties[blockTypeLabelProp.name]).toBe('See [[Bar]]')
      expect((await env.repo.query.aliasLookup({workspaceId: WS, alias: 'See [[Bar]]'}).load())?.id)
        .toBe(squatter)
    })
  })
})

// ──── retagBlocks ───────────────────────────────────────────────────

describe('retagBlocks', () => {
  it('applies the type to every instance id in one tx', async () => {
    env = await setup()
    const typeId = await createTypeBlock(env.repo, {workspaceId: WS, label: 'Task', propertySchemaIds: []})
    const a = await createBlock(env, 'Block A')
    const b = await createBlock(env, 'Block B')
    const c = await createBlock(env, 'Block C')

    await retagBlocks(env.repo, {typeId, instanceIds: [a, b, c]})

    for (const id of [a, b, c]) {
      const row = await env.repo.load(id)
      expect(getBlockTypes(row!)).toContain(typeId)
    }
  })

  it('is idempotent — re-tagging an already-tagged block is a no-op', async () => {
    env = await setup()
    const typeId = await createTypeBlock(env.repo, {workspaceId: WS, label: 'Task', propertySchemaIds: []})
    const id = await createBlock(env, 'A')
    await retagBlocks(env.repo, {typeId, instanceIds: [id]})
    await retagBlocks(env.repo, {typeId, instanceIds: [id]})
    const row = await env.repo.load(id)
    const tagged = getBlockTypes(row!).filter(t => t === typeId)
    expect(tagged).toHaveLength(1)
  })

  it('silently skips ids that are missing or tombstoned', async () => {
    env = await setup()
    const typeId = await createTypeBlock(env.repo, {workspaceId: WS, label: 'Task', propertySchemaIds: []})
    const liveId = await createBlock(env, 'Live')

    // Should not throw on a mix of live + missing ids.
    await retagBlocks(env.repo, {typeId, instanceIds: [liveId, 'missing-id']})

    const live = await env.repo.load(liveId)
    expect(getBlockTypes(live!)).toContain(typeId)
  })

  it('throws when the type is not registered', async () => {
    env = await setup()
    const id = await createBlock(env, 'A')
    await expect(retagBlocks(env.repo, {
      typeId: 'not-a-type',
      instanceIds: [id],
    })).rejects.toThrow(/type not-a-type is not registered/)
  })

  it('is a no-op when instanceIds is empty', async () => {
    env = await setup()
    const typeId = await createTypeBlock(env.repo, {workspaceId: WS, label: 'Task', propertySchemaIds: []})
    await expect(retagBlocks(env.repo, {typeId, instanceIds: []})).resolves.toBeUndefined()
  })

  it('honors an aborted signal pre-flight', async () => {
    env = await setup()
    const typeId = await createTypeBlock(env.repo, {workspaceId: WS, label: 'Task', propertySchemaIds: []})
    const id = await createBlock(env, 'A')
    const controller = new AbortController()
    controller.abort()
    await expect(retagBlocks(env.repo, {
      typeId,
      instanceIds: [id],
      signal: controller.signal,
    })).rejects.toMatchObject({name: 'AbortError'})
    const row = await env.repo.load(id)
    expect(getBlockTypes(row!)).not.toContain(typeId)
  })

  it('silently skips instance ids that live in a different workspace', async () => {
    // Guard against the regression where retagBlocks trusted every
    // supplied instanceId without enforcing the type's workspace. A
    // stale caller (e.g. candidate list built before a sync-applied
    // move) could otherwise tag a cross-workspace block, breaking the
    // type-stays-in-its-workspace invariant.
    env = await setup()
    const typeId = await createTypeBlock(env.repo, {workspaceId: WS, label: 'Task', propertySchemaIds: []})

    // Plant a real block in a foreign workspace by bootstrapping its
    // Types page — that creates a kernel page row under `WS_OTHER`.
    // The page id is a perfectly valid block id from retagBlocks's
    // perspective, but its workspaceId is `WS_OTHER` (not `WS`).
    const WS_OTHER = 'ws-other'
    await getOrCreateTypesPage(env.repo, WS_OTHER)
    const foreignBlockId = typesPageBlockId(WS_OTHER)
    const foreignRow = await env.repo.load(foreignBlockId)
    expect(foreignRow?.workspaceId).toBe(WS_OTHER)

    // A same-workspace instance for the positive control.
    const liveId = await createBlock(env, 'A')

    await retagBlocks(env.repo, {
      typeId,
      instanceIds: [liveId, foreignBlockId],
    })

    const live = await env.repo.load(liveId)
    const foreign = await env.repo.load(foreignBlockId)
    expect(getBlockTypes(live!)).toContain(typeId)
    expect(getBlockTypes(foreign!)).not.toContain(typeId)
  })
})

// ──── findCandidatesByPropertyShape ─────────────────────────────────

describe('findCandidatesByPropertyShape', () => {
  it('returns blocks whose properties_json carries every named property', async () => {
    env = await setup()
    const statusSchema = await env.repo.userSchemas.addSchema({name: 'status', presetId: 'string'})
    const dueSchema = await env.repo.userSchemas.addSchema({name: 'due', presetId: 'string'})
    void statusSchema
    void dueSchema

    const hasBoth = await createBlock(env, 'Both', {status: 'open', due: '2026-05-20'})
    const hasOnlyStatus = await createBlock(env, 'OnlyStatus', {status: 'open'})
    const hasOnlyDue = await createBlock(env, 'OnlyDue', {due: '2026-05-20'})
    const hasNeither = await createBlock(env, 'Neither')

    const candidates = await findCandidatesByPropertyShape(env.repo, {
      workspaceId: WS,
      shape: [{name: 'status'}, {name: 'due'}],
    })

    expect(candidates).toContain(hasBoth)
    expect(candidates).not.toContain(hasOnlyStatus)
    expect(candidates).not.toContain(hasOnlyDue)
    expect(candidates).not.toContain(hasNeither)
  })

  it('respects per-property value filters', async () => {
    env = await setup()
    await env.repo.userSchemas.addSchema({name: 'status', presetId: 'string'})

    const open = await createBlock(env, 'Open', {status: 'open'})
    const done = await createBlock(env, 'Done', {status: 'done'})

    const candidates = await findCandidatesByPropertyShape(env.repo, {
      workspaceId: WS,
      shape: [{name: 'status', value: 'open'}],
    })

    expect(candidates).toContain(open)
    expect(candidates).not.toContain(done)
  })

  it('excludes ids passed in `exclude` (typical: the prototype itself)', async () => {
    env = await setup()
    await env.repo.userSchemas.addSchema({name: 'status', presetId: 'string'})

    const prototype = await createBlock(env, 'Prototype', {status: 'open'})
    const sibling = await createBlock(env, 'Sibling', {status: 'open'})

    const candidates = await findCandidatesByPropertyShape(env.repo, {
      workspaceId: WS,
      shape: [{name: 'status'}],
      exclude: [prototype],
    })

    expect(candidates).not.toContain(prototype)
    expect(candidates).toContain(sibling)
  })

  it('returns an empty array when shape is empty (no implicit "everything" match)', async () => {
    env = await setup()
    await createBlock(env, 'A')
    const candidates = await findCandidatesByPropertyShape(env.repo, {
      workspaceId: WS,
      shape: [],
    })
    expect(candidates).toEqual([])
  })

  it('caps results at the limit when given', async () => {
    env = await setup()
    await env.repo.userSchemas.addSchema({name: 'status', presetId: 'string'})
    for (let i = 0; i < 5; i++) {
      await createBlock(env, `B${i}`, {status: 'open'})
    }
    const candidates = await findCandidatesByPropertyShape(env.repo, {
      workspaceId: WS,
      shape: [{name: 'status'}],
      limit: 3,
    })
    expect(candidates).toHaveLength(3)
  })

  it('targetIds: permissive refList match — block ⊇ targetIds counts', async () => {
    env = await setup()
    await env.repo.userSchemas.addSchema({name: 'tags', presetId: 'refList'})

    const person = await createBlock(env, 'Person')
    const friend = await createBlock(env, 'Friend')
    const stranger = await createBlock(env, 'Stranger')

    const onlyPerson = await createBlockWithRefs(env, 'OnlyPerson', 'tags', [person])
    const personAndFriend = await createBlockWithRefs(env, 'PersonAndFriend', 'tags', [person, friend])
    const onlyStranger = await createBlockWithRefs(env, 'OnlyStranger', 'tags', [stranger])

    const candidates = await findCandidatesByPropertyShape(env.repo, {
      workspaceId: WS,
      shape: [{name: 'tags', targetIds: [person]}],
    })

    expect(candidates).toContain(onlyPerson)
    expect(candidates).toContain(personAndFriend)
    expect(candidates).not.toContain(onlyStranger)
  })

  it('targetIds with multiple ids ANDs them — refList must be a superset', async () => {
    env = await setup()
    await env.repo.userSchemas.addSchema({name: 'tags', presetId: 'refList'})

    const a = await createBlock(env, 'A')
    const b = await createBlock(env, 'B')

    const hasA = await createBlockWithRefs(env, 'HasA', 'tags', [a])
    const hasB = await createBlockWithRefs(env, 'HasB', 'tags', [b])
    const hasBoth = await createBlockWithRefs(env, 'HasBoth', 'tags', [a, b])

    const candidates = await findCandidatesByPropertyShape(env.repo, {
      workspaceId: WS,
      shape: [{name: 'tags', targetIds: [a, b]}],
    })

    expect(candidates).toContain(hasBoth)
    expect(candidates).not.toContain(hasA)
    expect(candidates).not.toContain(hasB)
  })

  it('targetIds: empty array is treated as presence-only', async () => {
    env = await setup()
    await env.repo.userSchemas.addSchema({name: 'tags', presetId: 'refList'})

    const tag = await createBlock(env, 'Tag')
    const tagged = await createBlockWithRefs(env, 'Tagged', 'tags', [tag])
    const untagged = await createBlock(env, 'Untagged')

    const candidates = await findCandidatesByPropertyShape(env.repo, {
      workspaceId: WS,
      shape: [{name: 'tags', targetIds: []}],
    })

    expect(candidates).toContain(tagged)
    expect(candidates).not.toContain(untagged)
  })
})

// ──── Composition: extract-type-from-prototype flow ─────────────────

describe('extract-type-from-prototype composition', () => {
  it('createTypeBlock + findCandidatesByPropertyShape + retagBlocks compose end-to-end', async () => {
    env = await setup()
    const statusSchema = await env.repo.userSchemas.addSchema({name: 'status', presetId: 'string'})
    const dueSchema = await env.repo.userSchemas.addSchema({name: 'due', presetId: 'string'})
    const statusBlockId = env.repo.userSchemas.getSchemaBlockId(statusSchema.name)!
    const dueBlockId = env.repo.userSchemas.getSchemaBlockId(dueSchema.name)!

    // Prototype: a block with the property shape the user wants to canonize.
    const prototype = await createBlock(env, 'Buy milk', {status: 'open', due: '2026-05-20'})
    // Other blocks with the same shape — should become candidates.
    const otherA = await createBlock(env, 'Call mom', {status: 'open', due: '2026-05-21'})
    const otherB = await createBlock(env, 'Pay rent', {status: 'done', due: '2026-05-01'})
    // Off-shape block — should not be a candidate.
    const unrelated = await createBlock(env, 'Random', {})

    // Step 1: user names the type, picks the property subset → create the type definition.
    const typeId = await createTypeBlock(env.repo, {
      workspaceId: WS,
      label: 'Task',
      propertySchemaIds: [statusBlockId, dueBlockId],
    })

    // Step 2: find candidates with the same property shape, excluding the prototype.
    const candidates = await findCandidatesByPropertyShape(env.repo, {
      workspaceId: WS,
      shape: [{name: 'status'}, {name: 'due'}],
      exclude: [prototype],
    })

    expect(new Set(candidates)).toEqual(new Set([otherA, otherB]))
    expect(candidates).not.toContain(unrelated)
    expect(candidates).not.toContain(prototype)

    // Step 3: user confirms; retag the picked instances.
    await retagBlocks(env.repo, {typeId, instanceIds: candidates})

    for (const id of candidates) {
      const row = await env.repo.load(id)
      expect(getBlockTypes(row!)).toContain(typeId)
    }
    // Prototype was excluded — not retagged.
    const prototypeRow = await env.repo.load(prototype)
    expect(getBlockTypes(prototypeRow!)).not.toContain(typeId)
    // Unrelated was filtered by shape — also not retagged.
    const unrelatedRow = await env.repo.load(unrelated)
    expect(getBlockTypes(unrelatedRow!)).not.toContain(typeId)
  })
})

// ──── typesProp shape preservation ──────────────────────────────────

describe('retagBlocks preserves existing types', () => {
  it('appends rather than replacing', async () => {
    env = await setup()
    const typeId = await createTypeBlock(env.repo, {workspaceId: WS, label: 'Task', propertySchemaIds: []})
    const id = await createBlock(env, 'A')
    // Stamp an unrelated synthetic type id first.
    await env.repo.tx(async tx => {
      const row = await tx.get(id)
      if (!row) throw new Error('missing')
      await tx.update(id, {
        properties: {...row.properties, [typesProp.name]: ['some-other-type']},
      })
    }, {scope: ChangeScope.BlockDefault})

    await retagBlocks(env.repo, {typeId, instanceIds: [id]})

    const row = await env.repo.load(id)
    const types = getBlockTypes(row!)
    expect(types).toContain('some-other-type')
    expect(types).toContain(typeId)
  })
})
