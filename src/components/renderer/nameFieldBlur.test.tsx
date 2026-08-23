// @vitest-environment happy-dom

/** Focusing a definition's name field and leaving it must not rename the
 *  definition. Both editors trim on commit, and a committed name can
 *  legitimately carry surrounding whitespace (a pre-hygiene row, an import,
 *  or a synthesized orphan definition, which mints the cell key verbatim on
 *  purpose) — so an unconditional trim on blur renames without an edit, and
 *  a property definition's name is the cell key its values are stored
 *  under. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChangeScope } from '@/data/api'
import { BLOCK_TYPE_TYPE } from '@/data/blockTypes'
import { blockTypeLabelProp, propertyNameProp } from '@/data/properties'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { RepoContext } from '@/context/repo'
import { type FacetRuntime } from '@/facets/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import { PropertySchemaContentRenderer } from './PropertySchemaBlockRenderer'
import { BlockTypeContentRenderer } from './BlockTypeBlockRenderer'

// The type editor's "Add property" picker pulls in the shortcut/UI-state
// stack (and suspends on it); these tests only drive the label field.
vi.mock('@/components/propertyPanel/PropertyPicker.js', () => ({
  PropertyPicker: () => null,
}))

const WS = 'ws-1'
const PADDED_NAME = ' padded '
const PADDED_LABEL = ' Padded '

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
    await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Root'})
    await tx.create({
      id: 'padded-schema',
      workspaceId: WS,
      parentId: 'root',
      orderKey: 'a1',
      content: PADDED_NAME,
      properties: {
        types: ['property-schema'],
        'property-schema:name': PADDED_NAME,
        'property-schema:preset': 'string',
        'property-schema:config': {},
      },
    })
    await tx.create({
      id: 'padded-type',
      workspaceId: WS,
      parentId: 'root',
      orderKey: 'a2',
      content: PADDED_LABEL,
    })
    await repo.addTypeInTx(tx, 'padded-type', BLOCK_TYPE_TYPE, {})
    await tx.setProperty('padded-type', blockTypeLabelProp, PADDED_LABEL)
  }, {scope: ChangeScope.BlockDefault, description: 'padded-name fixture'})
})

afterEach(() => { cleanup() })

const renderSchema = async () => {
  await repo.block('padded-schema').load()
  return render(
    <AppRuntimeContextProvider value={runtime}>
      <PropertySchemaContentRenderer block={repo.block('padded-schema')} />
    </AppRuntimeContextProvider>,
  )
}

const renderType = async () => {
  await repo.block('padded-type').load()
  return render(
    <RepoContext.Provider value={repo}>
      <AppRuntimeContextProvider value={runtime}>
        <BlockTypeContentRenderer block={repo.block('padded-type')} />
      </AppRuntimeContextProvider>
    </RepoContext.Provider>,
  )
}

const storedName = () =>
  repo.block('padded-schema').peek()?.properties[propertyNameProp.name]

const storedLabel = () =>
  repo.block('padded-type').peek()?.properties[blockTypeLabelProp.name]

describe('name fields commit on blur only what the user edited', () => {
  it('leaves a padded property name untouched when the field is only focused', async () => {
    const user = userEvent.setup()
    await renderSchema()
    const input = screen.getByPlaceholderText('property name') as HTMLInputElement
    expect(input.value).toBe(PADDED_NAME)

    // Assert on the CAUSE: an unedited blur must not open a write at all.
    // (A "the name is unchanged" read alone passes trivially before an
    // in-flight write lands.)
    const txSpy = vi.spyOn(repo, 'tx')
    await user.click(input)
    await user.tab()

    expect(txSpy).not.toHaveBeenCalled()
    expect(storedName()).toBe(PADDED_NAME)
  })

  // Positive control for the test above: the same harness DOES observe a
  // rename, so the assertion isn't green for want of a working path.
  it('still trims a property name the user actually edited', async () => {
    const user = userEvent.setup()
    await renderSchema()
    const input = screen.getByPlaceholderText('property name') as HTMLInputElement

    await user.click(input)
    await user.type(input, 'x')
    await user.tab()

    await vi.waitFor(() => { expect(storedName()).toBe('padded x') })
  })

  it('leaves a padded type label untouched when the field is only focused', async () => {
    const user = userEvent.setup()
    await renderType()
    const input = screen.getByPlaceholderText('type label') as HTMLInputElement
    expect(input.value).toBe(PADDED_LABEL)

    const txSpy = vi.spyOn(repo, 'tx')
    await user.click(input)
    await user.tab()

    expect(txSpy).not.toHaveBeenCalled()
    expect(storedLabel()).toBe(PADDED_LABEL)
  })

  it('still trims a type label the user actually edited', async () => {
    const user = userEvent.setup()
    await renderType()
    const input = screen.getByPlaceholderText('type label') as HTMLInputElement

    await user.click(input)
    await user.type(input, 'X')
    await user.tab()

    await vi.waitFor(() => { expect(storedLabel()).toBe('Padded X') })
  })
})
