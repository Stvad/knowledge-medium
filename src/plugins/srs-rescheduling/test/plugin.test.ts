// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Check, ClipboardPaste, ClockArrowDown, Gauge, RotateCcw, Scissors, Sparkles } from 'lucide-react'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { Repo } from '@/data/repo'
import { createTestDb } from '@/data/test/createTestDb'
import { actionsFacet } from '@/extensions/core.js'
import { blockContentSurfacePropsFacet } from '@/extensions/blockInteraction.js'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import { propertySchemasFacet, typesFacet } from '@/data/facets.js'
import { SWIPE_RIGHT_BLOCK_ACTION_ID } from '@/plugins/swipe-quick-actions'
import { ActionConfig, ActionContextTypes } from '@/shortcuts/types.js'
import { getEffectiveActions } from '@/shortcuts/effectiveActions.js'
import {
  DATE_SCRUB_CONTEXT,
  dailyNoteBlockId,
  dailyNotesDataExtension,
  getOrCreateDailyNote,
} from '@/plugins/daily-notes'
import {
  type DateScrubDraft,
  endKeyboardScrub,
  registerScrubHandler,
  startKeyboardScrubForTarget,
} from '@/plugins/daily-notes/dateScrubGesture.js'
import { quickActionItemsFacet } from '@/plugins/swipe-quick-actions'
import {
  EDIT_MODE_TODO_CYCLE_ACTION_ID,
  TODO_CYCLE_ACTION_ID,
  todoActionsExtension,
} from '@/plugins/todo/actions.js'
import { todoDataExtension } from '@/plugins/todo/dataExtension.js'
import { statusProp, TODO_TYPE } from '@/plugins/todo/schema.js'
import {
  SRS_SM25_TYPE,
  srsArchivedProp,
  srsFactorProp,
  srsGradeProp,
  srsIntervalProp,
  srsNextReviewDateProp,
  srsReschedulingPlugin,
  srsReviewCountProp,
  srsSnapshotHistoryProp,
} from '../index.ts'
import {
  clearSrsClipboard,
  getSrsClipboard,
  setSrsClipboard,
} from '../srsClipboard.ts'

describe('srsReschedulingPlugin', () => {
  it('contributes the SRS SM-2.5 type and property schemas', () => {
    const runtime = resolveFacetRuntimeSync(srsReschedulingPlugin)
    const schemas = runtime.read(propertySchemasFacet)
    const types = runtime.read(typesFacet)

    expect(schemas.get(srsIntervalProp.name)).toBe(srsIntervalProp)
    expect(schemas.get(srsFactorProp.name)).toBe(srsFactorProp)
    expect(schemas.get(srsNextReviewDateProp.name)).toBe(srsNextReviewDateProp)
    expect(schemas.get(srsReviewCountProp.name)).toBe(srsReviewCountProp)
    expect(schemas.get(srsGradeProp.name)).toBe(srsGradeProp)
    expect(schemas.get(srsArchivedProp.name)).toBe(srsArchivedProp)
    expect(schemas.get(srsSnapshotHistoryProp.name)).toBe(srsSnapshotHistoryProp)
    expect(types.get(SRS_SM25_TYPE)?.properties).toEqual([
      srsIntervalProp,
      srsFactorProp,
      srsNextReviewDateProp,
      srsReviewCountProp,
      srsGradeProp,
      srsArchivedProp,
      srsSnapshotHistoryProp,
    ])
  })

  it('contributes matching actions in normal and edit mode', () => {
    const runtime = resolveFacetRuntimeSync(srsReschedulingPlugin)
    const actions = runtime.read(actionsFacet)

    expect(actions).toHaveLength(17)
    expect(actions.map(action => action.context)).toEqual([
      ActionContextTypes.NORMAL_MODE,
      ActionContextTypes.NORMAL_MODE,
      ActionContextTypes.NORMAL_MODE,
      ActionContextTypes.NORMAL_MODE,
      ActionContextTypes.NORMAL_MODE,
      ActionContextTypes.EDIT_MODE_CM,
      ActionContextTypes.EDIT_MODE_CM,
      ActionContextTypes.EDIT_MODE_CM,
      ActionContextTypes.EDIT_MODE_CM,
      ActionContextTypes.EDIT_MODE_CM,
      DATE_SCRUB_CONTEXT,
      DATE_SCRUB_CONTEXT,
      DATE_SCRUB_CONTEXT,
      DATE_SCRUB_CONTEXT,
      DATE_SCRUB_CONTEXT,
      ActionContextTypes.NORMAL_MODE,
      ActionContextTypes.NORMAL_MODE,
    ])

    expect(actions.slice(0, 5).map(action => action.icon)).toEqual([
      RotateCcw,
      Gauge,
      Check,
      Sparkles,
      ClockArrowDown,
    ])
    expect(actions.slice(5, 10).map(action => action.icon)).toEqual([
      RotateCcw,
      Gauge,
      Check,
      Sparkles,
      ClockArrowDown,
    ])
    expect(actions.slice(10, 15).map(action => action.id)).toEqual([
      'date-scrub.srs.reschedule.again',
      'date-scrub.srs.reschedule.hard',
      'date-scrub.srs.reschedule.good',
      'date-scrub.srs.reschedule.easy',
      'date-scrub.srs.reschedule.sooner',
    ])
    expect(actions.slice(10, 15).map(action => action.defaultBinding?.keys)).toEqual([
      'Digit1',
      'Digit2',
      'Digit3',
      'Digit4',
      'Digit5',
    ])
    expect(actions.slice(15).map(action => action.id)).toEqual(['srs.cut', 'srs.paste'])
    expect(actions.slice(15).map(action => action.icon)).toEqual([Scissors, ClipboardPaste])
  })

  const withSrsScrubRepo = async (
    run: (
      repo: Repo,
      block: ReturnType<Repo['block']>,
      actions: readonly ActionConfig[],
      getDraft: () => DateScrubDraft | null,
      setDraft: (draft: DateScrubDraft | null) => void,
    ) => Promise<void>,
  ) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 4, 5))
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    const h = await createTestDb()
    try {
      const repo = new Repo({
        db: h.db,
        cache: new BlockCache(),
        user: {id: 'user-1'},
        registerKernelProcessors: false,
      })
      repo.setFacetRuntime(resolveFacetRuntimeSync([
        kernelDataExtension,
        dailyNotesDataExtension,
        srsReschedulingPlugin,
      ]))

      const nextReview = await getOrCreateDailyNote(repo, 'ws-1', '2026-05-01')
      await repo.tx(tx => tx.create({
        id: 'srs-block',
        workspaceId: 'ws-1',
        parentId: null,
        orderKey: 'a',
        content: 'Card',
        properties: {
          types: [SRS_SM25_TYPE],
          [srsIntervalProp.name]: srsIntervalProp.codec.encode(10),
          [srsFactorProp.name]: srsFactorProp.codec.encode(2),
          [srsNextReviewDateProp.name]: srsNextReviewDateProp.codec.encode(nextReview.id),
          [srsReviewCountProp.name]: srsReviewCountProp.codec.encode(3),
        },
      }), {scope: ChangeScope.BlockDefault, description: 'seed srs block'})

      const block = repo.block('srs-block')
      await block.load()

      let draft: DateScrubDraft | null = null
      const unregister = registerScrubHandler({
        start: vi.fn(() => true),
        update: vi.fn(),
        end: vi.fn(),
        stage: vi.fn((_blockId, next) => {
          draft = next
          return true
        }),
        getDraft: vi.fn(() => draft),
      })

      try {
        expect(startKeyboardScrubForTarget({block})).toBe(true)

        const runtime = repo.facetRuntime
        if (!runtime) throw new Error('facet runtime missing')
        await run(repo, block, runtime.read(actionsFacet), () => draft, next => {
          draft = next
        })
      } finally {
        endKeyboardScrub(false)
        unregister()
      }
    } finally {
      await h.cleanup()
    }
  }

  const scrubAction = (
    actions: readonly ActionConfig[],
    id: string,
  ): ActionConfig<typeof DATE_SCRUB_CONTEXT> => {
    const action = actions.find(it => it.id === id) as
      ActionConfig<typeof DATE_SCRUB_CONTEXT> | undefined
    if (!action) throw new Error(`missing action ${id}`)
    expect(action.context).toBe(DATE_SCRUB_CONTEXT)
    return action
  }

  it('stages SRS reschedules in date scrub without writing until the draft commit runs', async () => {
    await withSrsScrubRepo(async (_repo, block, actions, getDraft) => {
      const action = scrubAction(actions, 'date-scrub.srs.reschedule.good')

      await action.handler({block, uiStateBlock: block} as never, {} as KeyboardEvent)

      const draft = getDraft()
      expect(draft).not.toBeNull()
      expect(draft!.preview.label).toBe('SRS GOOD')
      expect(draft!.preview.value).toBe('May 25')
      expect(draft!.preview.detail).toBe('10d -> 20d')
      expect(draft!.currentIso).toBe('2026-05-25')
      expect(block.get(srsReviewCountProp)).toBe(3)
      expect(block.get(srsNextReviewDateProp)).toBe(dailyNoteBlockId('ws-1', '2026-05-01'))

      await draft!.commit()

      expect(block.get(srsReviewCountProp)).toBe(4)
      expect(block.get(srsGradeProp)).toBe(4)
      expect(block.get(srsNextReviewDateProp)).toBe(dailyNoteBlockId('ws-1', '2026-05-25'))
    })
  })

  it('compounds repeated SRS scrub actions from the current SRS draft', async () => {
    await withSrsScrubRepo(async (_repo, block, actions, getDraft) => {
      const good = scrubAction(actions, 'date-scrub.srs.reschedule.good')

      await good.handler({block, uiStateBlock: block} as never, {} as KeyboardEvent)
      await good.handler({block, uiStateBlock: block} as never, {} as KeyboardEvent)

      const draft = getDraft()
      expect(draft).not.toBeNull()
      expect(draft!.preview.label).toBe('SRS GOOD')
      expect(draft!.preview.value).toBe('Jul 4')
      expect(draft!.preview.detail).toBe('20d -> 1mo')
      expect(draft!.currentIso).toBe('2026-07-04')

      await draft!.commit()

      expect(block.get(srsIntervalProp)).toBe(40)
      expect(block.get(srsReviewCountProp)).toBe(5)
      expect(block.get(srsNextReviewDateProp)).toBe(dailyNoteBlockId('ws-1', '2026-07-04'))
      expect(block.get(srsSnapshotHistoryProp)).toHaveLength(2)
    })
  })

  it('uses a date-adjusted scrub draft as the SRS scheduling base', async () => {
    await withSrsScrubRepo(async (_repo, block, actions, getDraft, setDraft) => {
      const good = scrubAction(actions, 'date-scrub.srs.reschedule.good')
      const baseDraft: DateScrubDraft = {
        id: 'date-scrub.date',
        currentIso: '2026-05-02',
        preview: {label: 'Scrub date', value: 'May 2', detail: '+1d'},
        payload: {
          plugin: 'daily-notes.date-scrub',
          initialIso: '2026-05-01',
          deltaDays: 1,
        },
        shiftDate: () => baseDraft,
        commit: async () => undefined,
      }
      setDraft(baseDraft)

      await good.handler({block, uiStateBlock: block} as never, {} as KeyboardEvent)

      const draft = getDraft()
      expect(draft).not.toBeNull()
      expect(draft!.preview.value).toBe('May 22')
      expect(draft!.currentIso).toBe('2026-05-22')
    })
  })

  it('does not treat an unshifted default date draft as a custom SRS base', async () => {
    await withSrsScrubRepo(async (_repo, block, actions, getDraft, setDraft) => {
      const good = scrubAction(actions, 'date-scrub.srs.reschedule.good')
      const baseDraft: DateScrubDraft = {
        id: 'date-scrub.date',
        currentIso: '2026-05-01',
        preview: {label: 'Scrub date', value: 'May 1', detail: 'unchanged'},
        payload: {
          plugin: 'daily-notes.date-scrub',
          initialIso: '2026-05-01',
          deltaDays: 0,
        },
        shiftDate: () => baseDraft,
        commit: async () => undefined,
      }
      setDraft(baseDraft)

      await good.handler({block, uiStateBlock: block} as never, {} as KeyboardEvent)

      const draft = getDraft()
      expect(draft).not.toBeNull()
      expect(draft!.preview.value).toBe('May 25')
      expect(draft!.currentIso).toBe('2026-05-25')
    })
  })

  it('contributes swipe quick actions and block decoration hook for SRS blocks', () => {
    const runtime = resolveFacetRuntimeSync(srsReschedulingPlugin)
    const items = runtime.read(quickActionItemsFacet)

    expect(items.map(item => item.actionId)).toEqual([
      'srs.reschedule.again',
      'srs.reschedule.hard',
      'srs.reschedule.good',
      'srs.reschedule.easy',
      'srs.cut',
      'srs.paste',
    ])
    expect(items.slice(0, 4).every(item => item.row === 2 && !item.overflow)).toBe(true)
    expect(items.slice(4).every(item => item.overflow === true)).toBe(true)

    const actions = runtime.read(actionsFacet)
    const cutAction = actions.find(it => it.id === 'srs.cut')
    const pasteAction = actions.find(it => it.id === 'srs.paste')
    expect(typeof cutAction?.canRun).toBe('function')
    expect(typeof pasteAction?.canRun).toBe('function')

    expect(runtime.contributions(blockContentSurfacePropsFacet)).toHaveLength(1)
  })

  it('decorates the swipe-right block action to archive SRS blocks', async () => {
    const h = await createTestDb()
    try {
      let txSeq = 0
      const repo = new Repo({
        db: h.db,
        cache: new BlockCache(),
        user: {id: 'user-1'},
        newTxSeq: () => ++txSeq,
        startSyncObserver: false,
      })
      const baseSwipeRight = vi.fn(async () => undefined)
      const runtime = resolveFacetRuntimeSync([
        kernelDataExtension,
        dailyNotesDataExtension,
        srsReschedulingPlugin,
        actionsFacet.of({
          id: SWIPE_RIGHT_BLOCK_ACTION_ID,
          description: 'Swipe right',
          context: ActionContextTypes.NORMAL_MODE,
          handler: baseSwipeRight,
        }, {source: 'test'}),
      ])
      repo.setFacetRuntime(runtime)

      const snapshot = repo.snapshotTypeRegistries()
      await repo.tx(async tx => {
        await tx.create({
          id: 'srs-block',
          workspaceId: 'ws-1',
          parentId: null,
          orderKey: 'a0',
          content: 'SRS',
        })
        await repo.addTypeInTx(tx, 'srs-block', SRS_SM25_TYPE, {}, snapshot)
        await tx.create({
          id: 'plain-block',
          workspaceId: 'ws-1',
          parentId: null,
          orderKey: 'a1',
          content: 'Plain',
        })
      }, {scope: ChangeScope.BlockDefault, description: 'seed swipe-right blocks'})

      const action = getEffectiveActions(runtime).find(it => it.id === SWIPE_RIGHT_BLOCK_ACTION_ID) as
        ActionConfig<typeof ActionContextTypes.NORMAL_MODE> | undefined
      expect(action).toBeDefined()

      const srsBlock = repo.block('srs-block')
      await srsBlock.load()
      await action!.handler({block: srsBlock, uiStateBlock: srsBlock}, {} as CustomEvent)
      expect(srsBlock.get(srsArchivedProp)).toBe(true)
      expect(baseSwipeRight).not.toHaveBeenCalled()

      const plainBlock = repo.block('plain-block')
      await plainBlock.load()
      await action!.handler({block: plainBlock, uiStateBlock: plainBlock}, {} as CustomEvent)
      expect(baseSwipeRight).toHaveBeenCalledOnce()
    } finally {
      await h.cleanup()
    }
  })

  it('decorates cmd-enter todo cycle actions to archive SRS blocks', async () => {
    const h = await createTestDb()
    try {
      let txSeq = 0
      const repo = new Repo({
        db: h.db,
        cache: new BlockCache(),
        user: {id: 'user-1'},
        newTxSeq: () => ++txSeq,
        registerKernelProcessors: false,
        startSyncObserver: false,
      })
      const runtime = resolveFacetRuntimeSync([
        kernelDataExtension,
        dailyNotesDataExtension,
        todoDataExtension,
        todoActionsExtension,
        srsReschedulingPlugin,
      ])
      repo.setFacetRuntime(runtime)

      const snapshot = repo.snapshotTypeRegistries()
      await repo.tx(async tx => {
        await tx.create({
          id: 'srs-normal',
          workspaceId: 'ws-1',
          parentId: null,
          orderKey: 'a0',
          content: 'SRS normal',
        })
        await repo.addTypeInTx(tx, 'srs-normal', SRS_SM25_TYPE, {}, snapshot)
        await tx.create({
          id: 'srs-edit',
          workspaceId: 'ws-1',
          parentId: null,
          orderKey: 'a1',
          content: 'SRS edit',
        })
        await repo.addTypeInTx(tx, 'srs-edit', SRS_SM25_TYPE, {}, snapshot)
        await tx.create({
          id: 'plain-normal',
          workspaceId: 'ws-1',
          parentId: null,
          orderKey: 'a2',
          content: 'Plain normal',
        })
        await tx.create({
          id: 'plain-edit',
          workspaceId: 'ws-1',
          parentId: null,
          orderKey: 'a3',
          content: 'Plain edit',
        })
      }, {scope: ChangeScope.BlockDefault, description: 'seed cmd-enter blocks'})

      const actions = getEffectiveActions(runtime)
      const normalAction = actions.find(action =>
        action.id === TODO_CYCLE_ACTION_ID && action.context === ActionContextTypes.NORMAL_MODE
      ) as ActionConfig<typeof ActionContextTypes.NORMAL_MODE> | undefined
      const editAction = actions.find(action =>
        action.id === EDIT_MODE_TODO_CYCLE_ACTION_ID && action.context === ActionContextTypes.EDIT_MODE_CM
      ) as ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> | undefined
      expect(normalAction).toBeDefined()
      expect(editAction).toBeDefined()

      const srsNormal = repo.block('srs-normal')
      await srsNormal.load()
      await normalAction!.handler({block: srsNormal, uiStateBlock: srsNormal}, {} as KeyboardEvent)
      expect(srsNormal.get(srsArchivedProp)).toBe(true)
      expect(srsNormal.types).toContain(SRS_SM25_TYPE)
      expect(srsNormal.types).not.toContain(TODO_TYPE)

      const srsEdit = repo.block('srs-edit')
      await srsEdit.load()
      await editAction!.handler({
        block: srsEdit,
        uiStateBlock: srsEdit,
        editorView: {dispatch: vi.fn()},
      } as never, {} as KeyboardEvent)
      expect(srsEdit.get(srsArchivedProp)).toBe(true)
      expect(srsEdit.types).toContain(SRS_SM25_TYPE)
      expect(srsEdit.types).not.toContain(TODO_TYPE)

      const plainNormal = repo.block('plain-normal')
      await plainNormal.load()
      await normalAction!.handler({block: plainNormal, uiStateBlock: plainNormal}, {} as KeyboardEvent)
      expect(plainNormal.types).toContain(TODO_TYPE)
      expect(plainNormal.get(statusProp)).toBe('open')

      const plainEdit = repo.block('plain-edit')
      await plainEdit.load()
      await editAction!.handler({
        block: plainEdit,
        uiStateBlock: plainEdit,
        editorView: {dispatch: vi.fn()},
      } as never, {} as KeyboardEvent)
      expect(plainEdit.types).toContain(TODO_TYPE)
      expect(plainEdit.get(statusProp)).toBe('open')
    } finally {
      await h.cleanup()
    }
  })

  describe('srs.cut / srs.paste flow', () => {
    const setupRepo = async () => {
      const h = await createTestDb()
      let txSeq = 0
      const repo = new Repo({
        db: h.db,
        cache: new BlockCache(),
        user: {id: 'user-1'},
        newTxSeq: () => ++txSeq,
        registerKernelProcessors: false,
        startSyncObserver: false,
      })
      const runtime = resolveFacetRuntimeSync([
        kernelDataExtension,
        dailyNotesDataExtension,
        srsReschedulingPlugin,
      ])
      repo.setFacetRuntime(runtime)
      return {h, repo, runtime}
    }

    const seedSrsBlock = async (
      repo: Repo,
      id: string,
      interval: number,
    ) => {
      const snapshot = repo.snapshotTypeRegistries()
      await repo.tx(async tx => {
        await tx.create({
          id,
          workspaceId: 'ws-1',
          parentId: null,
          orderKey: `a-${id}`,
          content: id,
        })
        await repo.addTypeInTx(tx, id, SRS_SM25_TYPE, {}, snapshot)
        const row = await tx.get(id)
        if (!row) throw new Error(`missing ${id}`)
        await tx.update(id, {
          properties: {
            ...row.properties,
            [srsIntervalProp.name]: srsIntervalProp.codec.encode(interval),
          },
        })
      }, {scope: ChangeScope.BlockDefault, description: `seed ${id}`})
    }

    const seedPlainBlock = async (repo: Repo, id: string) => {
      await repo.tx(async tx => {
        await tx.create({
          id,
          workspaceId: 'ws-1',
          parentId: null,
          orderKey: `a-${id}`,
          content: id,
        })
      }, {scope: ChangeScope.BlockDefault, description: `seed plain ${id}`})
    }

    afterEach(() => {
      clearSrsClipboard()
    })

    it('cut stashes the source block and paste moves SRS to the target', async () => {
      const {h, repo, runtime} = await setupRepo()
      try {
        await seedSrsBlock(repo, 'src', 13)
        await seedPlainBlock(repo, 'dst')

        const cut = runtime.read(actionsFacet).find(it => it.id === 'srs.cut') as
          ActionConfig<typeof ActionContextTypes.NORMAL_MODE>
        const paste = runtime.read(actionsFacet).find(it => it.id === 'srs.paste') as
          ActionConfig<typeof ActionContextTypes.NORMAL_MODE>

        const srcBlock = repo.block('src')
        await srcBlock.load()
        await cut.handler({block: srcBlock, uiStateBlock: srcBlock} as never, {} as KeyboardEvent)
        expect(getSrsClipboard()).toEqual({sourceBlockId: 'src', sourceWorkspaceId: 'ws-1'})

        const dstBlock = repo.block('dst')
        await dstBlock.load()
        await paste.handler({block: dstBlock, uiStateBlock: dstBlock} as never, {} as KeyboardEvent)
        expect(getSrsClipboard()).toBeNull()

        const dstData = await dstBlock.load()
        const srcData = await srcBlock.load()
        expect(dstData?.properties.types).toEqual([SRS_SM25_TYPE])
        expect(srsIntervalProp.codec.decode(dstData!.properties[srsIntervalProp.name])).toBe(13)
        expect(srcData?.properties.types ?? []).not.toContain(SRS_SM25_TYPE)
      } finally {
        await h.cleanup()
      }
    })

    // "cut on a non-SRS block is a no-op" is enforced by surfaces via
    // `canRun` (the gating test below) — the handler itself no longer
    // re-checks. Direct programmatic invocation that bypasses canRun is
    // out of contract.

    it('paste is a no-op when nothing is stashed', async () => {
      const {h, repo, runtime} = await setupRepo()
      try {
        await seedPlainBlock(repo, 'dst')

        const paste = runtime.read(actionsFacet).find(it => it.id === 'srs.paste') as
          ActionConfig<typeof ActionContextTypes.NORMAL_MODE>
        const block = repo.block('dst')
        await block.load()
        await paste.handler({block, uiStateBlock: block} as never, {} as KeyboardEvent)

        const data = await block.load()
        expect(data?.properties.types ?? []).not.toContain(SRS_SM25_TYPE)
      } finally {
        await h.cleanup()
      }
    })

    it('canRun gates cut to SRS blocks and paste to non-source blocks with a stash', async () => {
      const {h, repo, runtime} = await setupRepo()
      try {
        await seedSrsBlock(repo, 'src', 5)
        await seedPlainBlock(repo, 'plain')

        const actions = runtime.read(actionsFacet)
        const cutAction = actions.find(it => it.id === 'srs.cut') as
          ActionConfig<typeof ActionContextTypes.NORMAL_MODE>
        const pasteAction = actions.find(it => it.id === 'srs.paste') as
          ActionConfig<typeof ActionContextTypes.NORMAL_MODE>

        const srcBlock = repo.block('src')
        const plainBlock = repo.block('plain')
        await srcBlock.load()
        await plainBlock.load()

        // Cut visible on SRS blocks only.
        expect(cutAction.canRun!({block: srcBlock, uiStateBlock: srcBlock} as never)).toBe(true)
        expect(cutAction.canRun!({block: plainBlock, uiStateBlock: plainBlock} as never)).toBe(false)

        // Paste hidden until something is cut.
        expect(pasteAction.canRun!({block: plainBlock, uiStateBlock: plainBlock} as never)).toBe(false)

        setSrsClipboard({sourceBlockId: 'src', sourceWorkspaceId: 'ws-1'})
        expect(pasteAction.canRun!({block: plainBlock, uiStateBlock: plainBlock} as never)).toBe(true)
        // Paste hidden on the source block itself.
        expect(pasteAction.canRun!({block: srcBlock, uiStateBlock: srcBlock} as never)).toBe(false)
      } finally {
        await h.cleanup()
      }
    })
  })

  it('does not rewrite legacy inline SRS content from edit mode', async () => {
    const h = await createTestDb()
    try {
      let now = 1700_000_000_000
      let id = 0
      const repo = new Repo({
        db: h.db,
        cache: new BlockCache(),
        user: {id: 'user-1'},
        now: () => ++now,
        newId: () => `generated-${++id}`,
        registerKernelProcessors: false,
      })
      const runtime = resolveFacetRuntimeSync([
        kernelDataExtension,
        dailyNotesDataExtension,
        srsReschedulingPlugin,
      ])
      repo.setFacetRuntime(runtime)
      await repo.tx(async tx => {
        await tx.create({
          id: 'legacy-inline-srs',
          workspaceId: 'ws-1',
          parentId: null,
          orderKey: 'a0',
          content: 'Review [[May 1st, 2026]]',
        })
      }, {scope: ChangeScope.BlockDefault, description: 'seed legacy inline srs'})

      const action = runtime.read(actionsFacet).find(it =>
        it.id === 'edit.cm.srs.reschedule.good',
      ) as ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM>
      const block = repo.block('legacy-inline-srs')
      await block.load()
      const editorView = {dispatch: vi.fn()}

      await action.handler({
        block,
        uiStateBlock: block,
        editorView,
      } as never, {} as KeyboardEvent)

      expect(editorView.dispatch).not.toHaveBeenCalled()
      expect(block.data.content).toBe('Review [[May 1st, 2026]]')
      expect(block.types).toContain(SRS_SM25_TYPE)
    } finally {
      await h.cleanup()
    }
  })
})
