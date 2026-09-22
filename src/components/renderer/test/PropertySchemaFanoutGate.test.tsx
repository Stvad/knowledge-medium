// @vitest-environment happy-dom
/**
 * The gate in front of a definition change big enough to stop the app
 * (#1112): ask first, then hold a progress surface up for the wait.
 *
 * The CONSUMER COUNT is stubbed. What it counts is pinned where it is
 * answered — `propertyDefinitionChange.test.ts`, against real field rows — and
 * the threshold is in the thousands, so materializing enough consumers here
 * would only make these tests slow at proving something they are not about.
 * What they ARE about is the branch: which side of the threshold asks, what a
 * decline leaves behind, and whether the surface opens and closes around the
 * write.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The refusal's own postcondition, and the only monotonic one this file has:
// see the staleness test below for why the stored row cannot serve as a fence.
vi.mock('@/utils/toast.js', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/toast.js')>(),
  showError: vi.fn(),
}))
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChangeScope } from '@/data/api'
import { graphBackfillClaimBlockId } from '@/data/internals/graphBackfillClaim'
import { PROPERTY_CELL_BACKFILL_ID } from '@/data/internals/propertyCellBackfill'
import { MIGRATION_CLAIM_TYPE } from '@/data/blockTypes'
import {
  addBlockTypeToProperties,
  migrationClaimantProp,
  migrationClaimedAtProp,
  presetConfigProp,
  presetIdProp,
  propertyNameProp,
} from '@/data/properties'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { type FacetRuntime } from '@/facets/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { RepoContext } from '@/context/repo'
import { __resetDialogsForTests, getDialogQueue, subscribeDialogs } from '@/utils/dialogs'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import {
  LARGE_FANOUT_CONSUMERS,
  propertyDefinitionFanout,
  subscribePropertyDefinitionFanout,
  type PropertyDefinitionFanoutSnapshot,
  __resetPropertyDefinitionFanoutForTests,
} from '@/data/propertyDefinitionFanout'
import { queueDefinitionChange } from '@/data/propertyDefinitionFanout'
import { PropertySchemaContentRenderer } from '../PropertySchemaBlockRenderer'
import { useSyncExternalStore } from 'react'

const showError = vi.mocked((await import('@/utils/toast.js')).showError)

const WS = 'ws-fanout-gate'
const SCHEMA_ID = 'user-schema'
const REF_SCHEMA_ID = 'user-ref-schema'
const ENUM_SCHEMA_ID = 'user-enum-schema'

let sharedDb: TestDb
let repo: Repo
let runtime: FacetRuntime

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    extensions: [kernelPropertyUiExtension, kernelValuePresetsExtension],
  }).repo
  runtime = repo.facetRuntime!
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({
      id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Root',
    })
    await tx.create({
      id: SCHEMA_ID,
      workspaceId: WS,
      parentId: 'root',
      orderKey: 'a1',
      content: 'test:myProp',
      properties: {
        types: ['property-schema'],
        'property-schema:name': 'test:myProp',
        'property-schema:preset': 'string',
        'property-schema:config': {},
      },
    })
    // An optimistic config editor: the enum options editor keeps a draft, so
    // it is the one with state a change that does not land could strand.
    await tx.create({
      id: ENUM_SCHEMA_ID,
      workspaceId: WS,
      parentId: 'root',
      orderKey: 'a3',
      content: 'test:myEnum',
      properties: {
        types: ['property-schema'],
        'property-schema:name': 'test:myEnum',
        'property-schema:preset': 'enum',
        'property-schema:config': {options: [{value: 'a', label: 'A'}]},
      },
    })
    // The config gestures need a preset that CONTRIBUTES a config editor;
    // `string` has none, so the type picker is all the other tests can drive.
    await tx.create({
      id: REF_SCHEMA_ID,
      workspaceId: WS,
      parentId: 'root',
      orderKey: 'a2',
      content: 'test:myRef',
      properties: {
        types: ['property-schema'],
        'property-schema:name': 'test:myRef',
        'property-schema:preset': 'ref',
        'property-schema:config': {},
      },
    })
  }, {scope: ChangeScope.BlockDefault, description: 'fan-out gate fixture'})
})

afterEach(() => {
  showError.mockClear()
  // BEFORE `cleanup`, and it is not tidiness: the dialog queue is module
  // state, so a test that leaves one open hands it to the next test's render —
  // where Radix's `aria-hidden` over the rest of the tree makes the schema
  // editor's own controls unfindable, and the failure reads as a missing
  // combobox rather than a leaked dialog.
  __resetDialogsForTests()
  cleanup()
  __resetPropertyDefinitionFanoutForTests()
  vi.restoreAllMocks()
})

/** Radix marks the page `pointer-events: none` while a modal is up, which
 *  user-event reads as an unclickable control. The buttons under test are
 *  INSIDE that modal, so the check has nothing true to say here. */
const user = () => userEvent.setup({pointerEventsCheck: 0})

/** The size the gesture believes the fan-out is. Stubbed on the Repo seam the
 *  gate reads, so the ARGUMENTS it passes stay under test — a count scoped to
 *  the wrong workspace, or taken against the wrong block, is exactly the way
 *  this could size the wrong change and go unnoticed. */
const consumersAre = (count: number) =>
  vi.spyOn(repo, 'countPropertyDefinitionConsumers').mockResolvedValue(count)

/** `DialogHost` without its modal shadowing, which suspends on the workspace's
 *  UI-state block and needs the signed-in `UserContext` this render has no
 *  business standing up. Everything these tests are about — the `openDialog`
 *  queue, the real dialog component, `resolve`/`cancel` — is the same path. */
const TestDialogHost = () => {
  const queue = useSyncExternalStore(subscribeDialogs, getDialogQueue, getDialogQueue)
  return <>{queue.map(entry => {
    const Component = entry.Component
    return (
      <Component
        key={entry.id}
        {...entry.props}
        resolve={(value: unknown) => entry.finalize(value)}
        cancel={() => entry.finalize(null)}
      />
    )
  })}</>
}

const renderSchema = (blockId = SCHEMA_ID) =>
  render(
    <RepoContext value={repo}>
      <AppRuntimeContextProvider value={runtime}>
        <PropertySchemaContentRenderer block={repo.block(blockId)} />
        <TestDialogHost />
      </AppRuntimeContextProvider>
    </RepoContext>,
  )

const nameInput = () => screen.getByPlaceholderText('property name') as HTMLInputElement

const renameTo = async (next: string) => {
  const session = user()
  await session.tripleClick(nameInput())
  await session.keyboard(next)
  await session.tab()
}

const storedName = async (): Promise<unknown> => {
  const row = await sharedDb.db.get<{properties_json: string}>(
    'SELECT properties_json FROM blocks WHERE id = ?', [SCHEMA_ID],
  )
  return (JSON.parse(row.properties_json) as Record<string, unknown>)['property-schema:name']
}

/** Every snapshot the fan-out store published, so a run that opened and closed
 *  inside one awaited write is still observable afterwards. */
const recordFanoutRuns = (): Array<PropertyDefinitionFanoutSnapshot | null> => {
  const seen: Array<PropertyDefinitionFanoutSnapshot | null> = []
  subscribePropertyDefinitionFanout(() => { seen.push(propertyDefinitionFanout()) })
  return seen
}

describe('renaming a property with many consumers', () => {
  it('asks first, naming the blocks the change will rewrite', async () => {
    const count = consumersAre(LARGE_FANOUT_CONSUMERS)
    renderSchema()

    await renameTo('test:renamed')

    expect(await screen.findByText(/Rename “test:myProp” to “test:renamed”\?/)).toBeTruthy()
    expect(screen.getByText(/1,000 blocks use this property/)).toBeTruthy()
    // Announced, not merely present: Radix points `aria-describedby` at the
    // description, and the count and the freeze are what is being consented
    // to — a title plus two buttons is not a confirmation.
    const dialog = screen.getByRole('dialog')
    const describedBy = dialog.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)?.textContent)
      .toMatch(/1,000 blocks use this property/)
    // Sized against THIS definition in ITS workspace, not the ambient one.
    expect(count).toHaveBeenCalledWith(SCHEMA_ID, WS)
    expect(await storedName()).toBe('test:myProp')
  })

  it('writes the new name, with the surface up for the whole write', async () => {
    consumersAre(4_000)
    const seen = recordFanoutRuns()
    renderSchema()
    await renameTo('test:renamed')

    await user().click(await screen.findByRole('button', {name: 'Rename'}))

    await waitFor(async () => { expect(await storedName()).toBe('test:renamed') })
    expect(seen[0]).toMatchObject({propertyName: 'test:myProp', total: 4_000, done: null})
    // CLOSED at the end, and nothing else closes it: a run left open is a
    // modal over a workspace that is no longer busy.
    await waitFor(() => { expect(propertyDefinitionFanout()).toBeNull() })
  })

  it('feeds the surface real progress, end to end', async () => {
    // Everything else here mocks the COUNT, so nothing was driving an actual
    // fan-out through the gate — and the mark that makes a report
    // attributable is set inside the gesture's own transaction. Without it
    // no report is accepted and the modal counts nothing for the whole
    // freeze, which no amount of store-level testing would notice.
    await sharedDb.db.execute(
      `INSERT OR REPLACE INTO workspaces
         (id, name, owner_user_id, create_time, update_time, encryption_mode,
          wk_canary, properties_migration)
       VALUES (?, 'ws', 'user-1', 1, 1, 'none', NULL, 'children')`,
      [WS])
    const schema = await vi.waitFor(() => {
      const registered = repo.propertySchemas.get('test:myProp')
      if (!registered) throw new Error('[test] test:myProp not registered yet')
      return registered
    }, {timeout: 3000})
    await repo.tx(async tx => {
      await tx.create({
        id: 'consumer', workspaceId: WS, parentId: 'root', orderKey: 'b0', content: 'host',
      })
      await tx.setProperty('consumer', schema, 'v')
    }, {scope: ChangeScope.BlockDefault})
    consumersAre(4_000)
    const seen = recordFanoutRuns()
    renderSchema()
    await renameTo('test:renamed')

    await user().click(await screen.findByRole('button', {name: 'Rename'}))

    await waitFor(async () => { expect(await storedName()).toBe('test:renamed') })
    expect(seen.some(snapshot => snapshot?.done === 1)).toBe(true)
  })

  it('keeps a name typed while the previous rename was still in flight', async () => {
    // Below the threshold the field stays live through the whole write —
    // planned, counted, committed — so the user can be typing the next name
    // when the last one lands. Its own acknowledgement must not read as a
    // remote edit and take that typing away. HELD IN THE QUEUE so the
    // in-flight window is deterministic rather than a race with the count.
    consumersAre(3)
    renderSchema()
    let release!: () => void
    void queueDefinitionChange(() => new Promise<void>(resolve => { release = resolve }))
    // The queue hands the blocker its turn a microtask later, so `release`
    // does not exist until the queue has actually reached it.
    await Promise.resolve()

    fireEvent.change(nameInput(), {target: {value: 'test:first'}})
    fireEvent.blur(nameInput())
    fireEvent.change(nameInput(), {target: {value: 'test:second'}})
    release()

    await waitFor(async () => { expect(await storedName()).toBe('test:first') })
    expect(nameInput().value).toBe('test:second')
  })

  it('keeps a newer name when the rename before it turned out to be a no-op', async () => {
    // Same window, the other ending. A rename RE-AIMS past a peer, so a peer
    // rename is not what makes one fail — a peer arriving at the very name
    // this was heading for is: the planner then finds nothing to do. The
    // cleanup that puts the field back is about THIS request's draft, and
    // the user has typed past it.
    consumersAre(3)
    renderSchema()
    let release!: () => void
    void queueDefinitionChange(() => new Promise<void>(resolve => { release = resolve }))
    await Promise.resolve()

    fireEvent.change(nameInput(), {target: {value: 'test:first'}})
    fireEvent.blur(nameInput())
    await repo.tx(tx => tx.setProperty(SCHEMA_ID, propertyNameProp, 'test:first'),
      {scope: ChangeScope.BlockDefault})
    fireEvent.change(nameInput(), {target: {value: 'test:second'}})
    release()

    await waitFor(async () => { expect(await storedName()).toBe('test:first') })
    expect(nameInput().value).toBe('test:second')
    expect(showError).not.toHaveBeenCalled()
  })

  it('leaves the property alone when the change is declined, field included', async () => {
    consumersAre(4_000)
    renderSchema()
    await renameTo('test:renamed')

    await user().click(await screen.findByRole('button', {name: 'Cancel'}))

    await waitFor(() => { expect(nameInput().value).toBe('test:myProp') })
    expect(await storedName()).toBe('test:myProp')
    expect(propertyDefinitionFanout()).toBeNull()
    // A decline is the user's own answer, not something to report back at
    // them — only a change that was overtaken gets the toast.
    expect(showError).not.toHaveBeenCalled()
  })

  it('rejects a name the field rows could not bind to, without asking', async () => {
    // POSITION, not merely presence: the label hygiene runs BEFORE the gate.
    // Asked first, the user would agree to wait for a rename this renderer
    // then reverts on its own, having written nothing.
    consumersAre(4_000)
    renderSchema()

    await renameTo('test:bad]]name')

    await waitFor(() => { expect(nameInput().value).toBe('test:myProp') })
    expect(screen.queryByRole('button', {name: 'Rename'})).toBeNull()
    expect(await storedName()).toBe('test:myProp')
  })

  it('writes nothing when the definition moved while the user was deciding', async () => {
    // A confirmation is a human pause and sync keeps running through it.
    // Without the in-transaction re-read, agreeing to "rename test:myProp to
    // test:renamed" a moment after a peer renamed the same definition
    // performs "rename theirName to test:renamed" — consent about a
    // definition that no longer exists, and the peer's edit gone with no
    // record of it.
    consumersAre(4_000)
    renderSchema()
    await renameTo('test:renamed')
    await screen.findByRole('button', {name: 'Rename'})

    // The peer's write, landing while the dialog is up.
    await repo.tx(tx => tx.setProperty(SCHEMA_ID, propertyNameProp, 'test:fromAPeer'),
      {scope: ChangeScope.BlockDefault})
    await user().click(screen.getByRole('button', {name: 'Rename'}))

    // FENCED ON THE REFUSAL, not on the row. The peer's write has already
    // landed, so `storedName` reads its value from the moment it commits —
    // before the gate's transaction has even opened. Waiting on that passed
    // locally and failed under CI load, which is the whole shape of a proxy
    // fence. The toast is the postcondition and fires once.
    await waitFor(() => { expect(showError).toHaveBeenCalledOnce() })
    expect(await storedName()).toBe('test:fromAPeer')
    expect(propertyDefinitionFanout()).toBeNull()
    // AND THE FIELD SHOWS THEIRS. Putting the pre-dialog name back here
    // would stick — the resync has already adopted the peer's name, so it
    // will not correct the draft again — and the next blur would submit it,
    // undoing the very edit this refusal protected.
    await waitFor(() => { expect(nameInput().value).toBe('test:fromAPeer') })
  })

  it('writes nothing to a definition deleted while the user was deciding', async () => {
    // `tx.get` hands back the TOMBSTONE and its bag still reads as it did, so
    // comparing the bag alone writes through to a deleted row — which the
    // fan-out then skips, and a later restore fans nothing out either
    // because by then both sides of the restore carry the edit.
    consumersAre(4_000)
    renderSchema()
    await renameTo('test:renamed')
    await screen.findByRole('button', {name: 'Rename'})

    await repo.tx(tx => tx.delete(SCHEMA_ID), {scope: ChangeScope.BlockDefault})
    await user().click(screen.getByRole('button', {name: 'Rename'}))

    await waitFor(() => { expect(showError).toHaveBeenCalledOnce() })
    expect(await storedName()).toBe('test:myProp')
  })

  it('does not ask, or open a surface, for a change nobody will notice', async () => {
    consumersAre(LARGE_FANOUT_CONSUMERS - 1)
    const seen = recordFanoutRuns()
    renderSchema()

    await renameTo('test:renamed')

    await waitFor(async () => { expect(await storedName()).toBe('test:renamed') })
    expect(screen.queryByText(/Rename “test:myProp”/)).toBeNull()
    expect(seen).toEqual([])
  })
})

describe('changing the options of a property with many consumers', () => {
  it('refuses when the PRESET moved, even though the config still matches', async () => {
    // The encoded config was produced by THIS preset's `configCodec`, so a
    // preset that moved under the dialog would store it against a codec that
    // never saw it — and two presets sharing a default config leave the
    // config comparison alone passing while exactly that happens.
    consumersAre(4_000)
    renderSchema(REF_SCHEMA_ID)
    const session = user()
    screen.getByPlaceholderText('Add a block type…').focus()
    await session.keyboard('page{Enter}')
    await screen.findByRole('button', {name: 'Change options'})

    // The peer's write: a different preset, and the config left as it was.
    await repo.tx(tx => tx.setProperty(REF_SCHEMA_ID, presetIdProp, 'optional-ref'),
      {scope: ChangeScope.BlockDefault})
    await session.click(screen.getByRole('button', {name: 'Change options'}))

    await waitFor(() => { expect(showError).toHaveBeenCalledOnce() })
    const row = await sharedDb.db.get<{properties_json: string}>(
      'SELECT properties_json FROM blocks WHERE id = ?', [REF_SCHEMA_ID],
    )
    const properties = JSON.parse(row.properties_json) as Record<string, unknown>
    expect(properties['property-schema:config']).toEqual({})
    expect(properties['property-schema:preset']).toBe('optional-ref')
  })
})

describe('a change planned against a row that moved while it waited', () => {
  it('labels a waiting rename with the name the definition has when its turn comes', async () => {
    // HELD IN THE QUEUE deliberately: what a change is planned against is
    // only observable while something is ahead of it, and the queue is the
    // seam that produces that state without a second racing gesture.
    consumersAre(4_000)
    renderSchema()
    let release!: () => void
    void queueDefinitionChange(() => new Promise<void>(resolve => { release = resolve }))

    fireEvent.change(nameInput(), {target: {value: 'test:renamed'}})
    fireEvent.blur(nameInput())
    // Lands while the rename waits — so the name it is replacing is not the
    // one the gesture was composed against.
    await repo.tx(tx => tx.setProperty(SCHEMA_ID, propertyNameProp, 'test:fromAPeer'),
      {scope: ChangeScope.BlockDefault})
    release()

    expect(await screen.findByText(/Rename “test:fromAPeer” to “test:renamed”\?/)).toBeTruthy()
  })

  it('labels a waiting re-type with the name its predecessor gave the definition', async () => {
    // Two gestures from one action: the rename lands first, and the type
    // change behind it was composed when the property still had its old
    // name. A whole replacement value means the same thing from any starting
    // point, so what moves is which name the dialog shows — not whether to
    // make the change.
    consumersAre(4_000)
    renderSchema()

    fireEvent.change(nameInput(), {target: {value: 'test:renamed'}})
    fireEvent.blur(nameInput())
    fireEvent.change(screen.getByRole('combobox'), {target: {value: 'number'}})
    await user().click(await screen.findByRole('button', {name: 'Rename'}))

    // The second dialog names the property as it stands NOW, not as the
    // gesture found it.
    expect(await screen.findByText(/Change the type of “test:renamed”\?/)).toBeTruthy()
    expect(showError).not.toHaveBeenCalled()
  })

  it('abandons a config edit composed before the row moved, without asking first', async () => {
    // The one payload that cannot be re-aimed: it is the editor's view of
    // the stored object with one part changed, so applying it over a row
    // that has moved would put back what the change before it removed.
    //
    // It abandons in the PLANNER, which is the part worth pinning — carried
    // as far as the transaction it would be refused there too, but only
    // after making the user count a graph and confirm a change that was
    // never going to land, and told it was a conflict with somebody else.
    const count = consumersAre(4_000)
    renderSchema(REF_SCHEMA_ID)
    let release!: () => void
    void queueDefinitionChange(() => new Promise<void>(resolve => { release = resolve }))
    const session = user()
    screen.getByPlaceholderText('Add a block type…').focus()
    await session.keyboard('page{Enter}')
    await repo.tx(tx => tx.setProperty(REF_SCHEMA_ID, presetConfigProp, {targetTypes: ['task']}),
      {scope: ChangeScope.BlockDefault})
    release()

    await waitFor(() => { expect(showError).toHaveBeenCalledOnce() })
    expect(showError.mock.calls[0]?.[0]).toMatch(/changed before this was applied/)
    expect(count).not.toHaveBeenCalled()
    const row = await sharedDb.db.get<{properties_json: string}>(
      'SELECT properties_json FROM blocks WHERE id = ?', [REF_SCHEMA_ID],
    )
    expect((JSON.parse(row.properties_json) as Record<string, unknown>)['property-schema:config'])
      .toEqual({targetTypes: ['task']})
  })

  it('makes the options editor forget a change that did not land', async () => {
    // A config editor holds its own in-progress state and learns nothing
    // from `onChange`, so a cancelled change leaves it showing options the
    // definition never got — and a later edit resubmits them. The host is
    // the only one that knows, and remounting is how it says so.
    consumersAre(4_000)
    renderSchema(ENUM_SCHEMA_ID)
    const session = user()

    await session.click(screen.getByRole('button', {name: 'Add choice'}))

    // The editor is showing the choice it asked for, uncommitted.
    expect(await screen.findByRole('button', {name: 'Change options'})).toBeTruthy()
    // An options change moves the codec, not the TYPE — telling the user
    // their values face a "new type" describes something they did not ask
    // for.
    expect(screen.getByText(/re-read under the new settings/)).toBeTruthy()
    expect(screen.getAllByLabelText(/Choice \d+ value/)).toHaveLength(2)

    await session.click(screen.getByRole('button', {name: 'Cancel'}))

    await waitFor(() => {
      expect(screen.getAllByLabelText(/Choice \d+ value/)).toHaveLength(1)
    })
  })

  it('reports a change the KERNEL refused as not written, cleanup and all', async () => {
    // The fixture has to reach a REAL same-tx refusal, after the callback
    // has already written: same-tx processors run once `fn` returns, so a
    // test that rejects `repo.tx` at the seam never runs the callback and
    // cannot tell whether success was recorded inside it.
    //
    // The migration claim is the refusal that needs no consumers: any
    // definition change is turned away while a peer holds it.
    await sharedDb.db.execute(
      `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
         properties_json, deleted, created_at, updated_at, user_updated_at,
         created_by, updated_by)
       VALUES (?, ?, NULL, 'k-claim', ?, ?, 0, 1, 1, 1, 'user-1', 'user-1')`,
      [graphBackfillClaimBlockId(WS, PROPERTY_CELL_BACKFILL_ID), WS,
        PROPERTY_CELL_BACKFILL_ID,
        JSON.stringify(addBlockTypeToProperties({
          [migrationClaimantProp.name]: 'peer-device',
          [migrationClaimedAtProp.name]: 1,
        }, MIGRATION_CLAIM_TYPE))])
    consumersAre(3)
    renderSchema()

    await renameTo('test:renamed')

    // The field goes back to what the definition says, which is the cleanup
    // that a write reported as successful skips.
    await waitFor(() => { expect(nameInput().value).toBe('test:myProp') })
    expect(await storedName()).toBe('test:myProp')
    // The kernel's own message is the only one.
    expect(showError).not.toHaveBeenCalled()
  })

  it('asks nothing at all when the row already reads the way the gesture wanted', async () => {
    // Reachable with no editing: the ref picker re-emits its list when a
    // target type already on it is entered again. Counting a whole graph to
    // confirm a write of the same bytes is the confirmation at its least
    // trustworthy, so the planner stops before the count.
    const count = consumersAre(4_000)
    await repo.tx(tx => tx.setProperty(REF_SCHEMA_ID, presetConfigProp, {targetTypes: ['page']}),
      {scope: ChangeScope.BlockDefault})
    renderSchema(REF_SCHEMA_ID)
    // The gate reads the row before it plans, so this rising is the proof
    // that the gesture got as far as planning — without it the assertions
    // below are true of a gesture that never started.
    const planned = vi.spyOn(repo, 'load')
    const plannedFor = () =>
      planned.mock.calls.filter(([id]) => id === REF_SCHEMA_ID).length
    const before = plannedFor()
    const session = user()
    screen.getByPlaceholderText('Add a block type…').focus()

    await session.keyboard('page{Enter}')

    // FENCED ON THE QUEUE, not on the planner having been reached: the load
    // spy firing says the change started, not that it finished, so a
    // planner that went on to count would still be mid-flight when the
    // assertions below ran. The queue is FIFO, so a change enqueued after
    // this one completes only once it has.
    await queueDefinitionChange(async () => {})
    expect(plannedFor()).toBeGreaterThan(before)
    expect(count).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', {name: 'Change options'})).toBeNull()
    expect(showError).not.toHaveBeenCalled()
  })
})

describe('two changes confirmed from one gesture', () => {
  it('runs them one at a time, each sized after the last one landed', async () => {
    // Blurring the name field and clicking the type picker in one gesture
    // reaches the gate twice, and each awaits a count before opening its
    // dialog — so both dialogs would queue and both could be confirmed, with
    // the second sized and judged against a row the first is about to
    // change.
    const count = consumersAre(4_000)
    renderSchema()

    // Dispatched synchronously, in one tick, because that is the shape: one
    // user action, two gate entries. Two concurrent `userEvent` sessions
    // would interleave their own pointer choreography and race instead.
    fireEvent.change(nameInput(), {target: {value: 'test:renamed'}})
    fireEvent.blur(nameInput())
    fireEvent.change(screen.getByRole('combobox'), {target: {value: 'number'}})

    // ONE dialog, not two stacked — and the second gesture has not even
    // asked for its count yet.
    await screen.findByRole('button', {name: 'Rename'})
    expect(screen.queryByRole('button', {name: 'Change type'})).toBeNull()
    expect(count).toHaveBeenCalledOnce()

    await user().click(screen.getByRole('button', {name: 'Rename'}))

    // Only once the rename has landed does the re-type ask, with a count
    // taken after it.
    expect(await screen.findByRole('button', {name: 'Change type'})).toBeTruthy()
    expect(await storedName()).toBe('test:renamed')
    expect(count).toHaveBeenCalledTimes(2)
  })
})

describe('re-typing a property with many consumers', () => {
  it('asks before a change that re-reads every stored value', async () => {
    consumersAre(4_000)
    renderSchema()

    await user().selectOptions(screen.getByRole('combobox'), 'number')

    expect(await screen.findByText(/Change the type of “test:myProp”\?/)).toBeTruthy()
    // The half a rename does not have: a re-type can be refused outright —
    // and it says the TYPE, which an options change must not.
    expect(screen.getByText(/re-read under the new type/)).toBeTruthy()
  })

  it('takes the surface down when the kernel refuses the change', async () => {
    // The run is ended from a `finally`, and this is the branch that needs it:
    // a refusal rolls the transaction back and reports nothing on the way out,
    // so an end placed after the write would leave a modal over a workspace
    // that is no longer busy — with no gesture left to close it.
    await sharedDb.db.execute(
      `INSERT OR REPLACE INTO workspaces
         (id, name, owner_user_id, create_time, update_time, encryption_mode,
          wk_canary, properties_migration)
       VALUES (?, 'ws', 'user-1', 1, 1, 'none', NULL, 'children')`,
      [WS])
    const schema = await vi.waitFor(() => {
      const registered = repo.propertySchemas.get('test:myProp')
      if (!registered) throw new Error('[test] test:myProp not registered yet')
      return registered
    }, {timeout: 3000})
    // Prose under a string property: `number` cannot read it, so the re-type
    // is refused rather than dropping it.
    await repo.tx(async tx => {
      await tx.create({
        id: 'host', workspaceId: WS, parentId: 'root', orderKey: 'a3', content: 'host',
      })
      await tx.setProperty('host', schema, 'not a number')
    }, {scope: ChangeScope.BlockDefault})
    consumersAre(4_000)
    const seen = recordFanoutRuns()
    renderSchema()
    await user().selectOptions(screen.getByRole('combobox'), 'number')

    await user().click(await screen.findByRole('button', {name: 'Change type'}))

    // The run DID open — otherwise the close below would be about nothing.
    await waitFor(() => { expect(seen.length).toBeGreaterThan(0) })
    await waitFor(() => { expect(propertyDefinitionFanout()).toBeNull() })
    // A refusal comes out of `repo.tx` as a THROW. Until the gate caught it
    // no caller's cleanup ran and a void handler was left with an unhandled
    // rejection; and the kernel has already said why in its own words, so
    // this must not answer with a conflict message over the top of it.
    expect(showError).not.toHaveBeenCalled()
  })

  it('refuses when a config edit landed that the reset would discard', async () => {
    // The re-type replaces the config as well as the preset — resetting it
    // to the new preset's default is the point — so a config edit that
    // arrived while the confirmation was up is one this would throw away
    // without ever having looked at it.
    consumersAre(4_000)
    renderSchema(REF_SCHEMA_ID)
    // The ref preset's own config editor contributes a second combobox, so
    // the type picker is named by position rather than by role alone.
    await user().selectOptions(screen.getAllByRole('combobox')[0]!, 'string')
    await screen.findByRole('button', {name: 'Change type'})

    await repo.tx(tx => tx.setProperty(REF_SCHEMA_ID, presetConfigProp, {targetTypes: ['task']}),
      {scope: ChangeScope.BlockDefault})
    await user().click(screen.getByRole('button', {name: 'Change type'}))

    await waitFor(() => { expect(showError).toHaveBeenCalledOnce() })
    const row = await sharedDb.db.get<{properties_json: string}>(
      'SELECT properties_json FROM blocks WHERE id = ?', [REF_SCHEMA_ID],
    )
    const properties = JSON.parse(row.properties_json) as Record<string, unknown>
    expect(properties['property-schema:preset']).toBe('ref')
    expect(properties['property-schema:config']).toEqual({targetTypes: ['task']})
  })

  it('leaves the stored type alone when declined', async () => {
    consumersAre(4_000)
    renderSchema()
    await user().selectOptions(screen.getByRole('combobox'), 'number')

    await user().click(await screen.findByRole('button', {name: 'Cancel'}))

    const row = await sharedDb.db.get<{properties_json: string}>(
      'SELECT properties_json FROM blocks WHERE id = ?', [SCHEMA_ID],
    )
    const properties = JSON.parse(row.properties_json) as Record<string, unknown>
    expect(properties['property-schema:preset']).toBe('string')
  })
})
