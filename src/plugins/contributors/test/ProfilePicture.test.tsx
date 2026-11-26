// @vitest-environment happy-dom
import {act, cleanup, fireEvent, render, waitFor} from '@testing-library/react'
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest'
import {ChangeScope} from '@/data/api'
import {typesProp} from '@/data/properties'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {MEDIA_TYPE, mediaHashProp, mediaMimeProp} from '@/plugins/attachments/mediaBlock'
import {ProfilePicture} from '../ProfilePicture'

const {resolve} = vi.hoisted(() => ({resolve: vi.fn()}))
vi.mock('@/plugins/attachments/assetResolver', () => {
  const resolver = {resolve}
  return {getAssetResolver: () => resolver}
})

const WORKSPACE = 'workspace'
const options = {scope: ChangeScope.BlockDefault}
let db: TestDb

beforeAll(async () => { db = await createTestDb() })
beforeEach(async () => {
  await resetTestDb(db.db)
  resolve.mockReset()
  resolve.mockResolvedValue({ok: true, bytes: new Uint8Array([1])})
})
afterEach(cleanup)
afterAll(async () => { await db.cleanup() })

it('renders a verified decorative image and drops it on decode failure or media deletion', async () => {
  const {repo} = createTestRepo({db: db.db})
  await repo.tx(tx => tx.create({
    id: 'picture', workspaceId: WORKSPACE, parentId: null, orderKey: 'a', content: '',
    properties: {[typesProp.name]: [MEDIA_TYPE], [mediaHashProp.name]: 'sha256:ab', [mediaMimeProp.name]: 'image/png'},
  }), options)
  const {container, unmount} = render(
    <ProfilePicture block={repo.block('comment')} pictureId="picture" workspaceId={WORKSPACE} />,
  )
  const getImage = () => container.querySelector('img')
  await waitFor(() => expect(getImage()).toHaveAttribute('src', expect.stringMatching(/^blob:/)))
  expect(getImage()).toHaveAttribute('alt', '')
  expect(resolve).toHaveBeenCalledWith({workspaceId: WORKSPACE, contentHash: 'sha256:ab'})
  fireEvent.error(getImage()!)
  await waitFor(() => expect(getImage()).toBeNull())
  unmount()

  const secondMount = render(
    <ProfilePicture block={repo.block('comment')} pictureId="picture" workspaceId={WORKSPACE} />,
  )
  await waitFor(() => expect(secondMount.container.querySelector('img')).toBeInTheDocument())
  await act(async () => { await repo.tx(tx => tx.delete('picture'), options) })
  await waitFor(() => expect(secondMount.container.querySelector('img')).toBeNull())
})

it.each([
  {workspaceId: 'elsewhere', types: [MEDIA_TYPE], mime: 'image/png', hash: 'sha256:ab'},
  {workspaceId: WORKSPACE, types: [], mime: 'image/png', hash: 'sha256:ab'},
  {workspaceId: WORKSPACE, types: [MEDIA_TYPE], mime: 'application/pdf', hash: 'sha256:ab'},
  {workspaceId: WORKSPACE, types: [MEDIA_TYPE], mime: 'image/png', hash: ''},
])('skips the resolver for ineligible media %j', async ({workspaceId, types, mime, hash}) => {
  const {repo} = createTestRepo({db: db.db})
  await repo.tx(tx => tx.create({
    id: 'picture', workspaceId, parentId: null, orderKey: 'a', content: '',
    properties: {[typesProp.name]: types, [mediaHashProp.name]: hash, [mediaMimeProp.name]: mime},
  }), options)
  expect(await repo.block('picture').load()).toMatchObject({workspaceId, deleted: false})
  const {container} = render(
    <ProfilePicture block={repo.block('comment')} pictureId="picture" workspaceId={WORKSPACE} />,
  )
  expect(resolve).not.toHaveBeenCalled()
  expect(container.querySelector('img')).toBeNull()
})
