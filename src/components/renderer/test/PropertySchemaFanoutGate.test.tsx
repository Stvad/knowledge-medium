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
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChangeScope } from '@/data/api'
import { propertyNameProp } from '@/data/properties'
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
import { PropertySchemaContentRenderer } from '../PropertySchemaBlockRenderer'
import { useSyncExternalStore } from 'react'

const WS = 'ws-fanout-gate'
const SCHEMA_ID = 'user-schema'

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
  }, {scope: ChangeScope.BlockDefault, description: 'fan-out gate fixture'})
})

afterEach(() => {
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

const renderSchema = () =>
  render(
    <RepoContext value={repo}>
      <AppRuntimeContextProvider value={runtime}>
        <PropertySchemaContentRenderer block={repo.block(SCHEMA_ID)} />
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

  it('leaves the property alone when the change is declined, field included', async () => {
    consumersAre(4_000)
    renderSchema()
    await renameTo('test:renamed')

    await user().click(await screen.findByRole('button', {name: 'Cancel'}))

    await waitFor(() => { expect(nameInput().value).toBe('test:myProp') })
    expect(await storedName()).toBe('test:myProp')
    expect(propertyDefinitionFanout()).toBeNull()
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

    await waitFor(async () => { expect(await storedName()).toBe('test:fromAPeer') })
    expect(propertyDefinitionFanout()).toBeNull()
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

describe('re-typing a property with many consumers', () => {
  it('asks before a change that re-reads every stored value', async () => {
    consumersAre(4_000)
    renderSchema()

    await user().selectOptions(screen.getByRole('combobox'), 'number')

    expect(await screen.findByText(/Change the type of “test:myProp”\?/)).toBeTruthy()
    // The half a rename does not have: a re-type can be refused outright.
    expect(screen.getByText(/the whole change is refused/)).toBeTruthy()
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
