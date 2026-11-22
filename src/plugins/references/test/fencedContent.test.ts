// @vitest-environment node
/** A table's query is a string property whose value block holds a fenced code
 *  block. The value round-trips exactly through the projection, and the names
 *  inside the fence are references like any block's: the fence changes nothing
 *  for the reference index, so a rename rewrites the query too. */
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {ChangeScope} from '@/data/api'
import {aliasesProp} from '@/data/properties'
import {aliasDataExtension} from '@/plugins/alias/dataExtension.js'
import {referencesDataExtension} from '@/plugins/references/dataExtension.js'
import {createStringValueHarness, queryProperty, type StringValueHarness} from '@/data/test/stringValueHarness'
import {createTestDb, type TestDb} from '@/data/test/createTestDb'

const MARY = '0190a0c0-0000-7000-8000-000000000001'
const TARGET = '0190a0c0-0000-7000-8000-000000000002'
const options = {scope: ChangeScope.BlockDefault}
const MENTIONS = `#task status=open [[Mary]] ((${TARGET}))`
const FENCED = `\`\`\`query\n${MENTIONS}\nkey:: value\nuse \`x\` and \`\`\` inside\n\`\`\`\n\n`

let db: TestDb
let env: StringValueHarness
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  env = await createStringValueHarness(db, [referencesDataExtension, aliasDataExtension])
  await env.repo.tx(async tx => {
    await tx.create({id: MARY, workspaceId: env.workspaceId, parentId: null, orderKey: 'a1', content: 'Mary'})
    await tx.setProperty(MARY, aliasesProp, ['Mary'])
    await tx.create({id: TARGET, workspaceId: env.workspaceId, parentId: null, orderKey: 'a2', content: 'target'})
  }, options)
  await env.repo.awaitProcessors()
})
afterEach(() => env.dispose())

const referencesFrom = (sourceId: string) =>
  db.db.getAll<{target_id: string}>('SELECT target_id FROM block_references WHERE source_id = ? ORDER BY target_id', [sourceId])

describe('a fenced string value', () => {
  it('projects exactly what its value block holds', async () => {
    await env.typeIntoValue(FENCED)
    expect(await env.projected()).toBe(FENCED)
  })

  it('writes exactly the stored value into its value block', async () => {
    const text = `${FENCED}trailing line\n`
    await env.repo.tx(tx => tx.setProperty(env.ownerId, queryProperty, text), options)
    expect(await env.valueContents()).toEqual([text])
    expect(await env.projected()).toBe(text)
  })
})

describe('references inside a fence', () => {
  it.each([
    {where: 'in a fence', content: FENCED},
    {where: 'outside a fence', content: MENTIONS},
  ])('are indexed $where, in a value block and in an ordinary block', async ({content}) => {
    const valueId = await env.typeIntoValue(content)
    await env.repo.tx(tx => tx.create({id: 'plain', workspaceId: env.workspaceId, parentId: null, orderKey: 'a3', content}), options)
    await env.repo.awaitProcessors()

    // `#task` is no reference form: a tag is applied by type completion, never parsed from text.
    for (const source of [valueId, 'plain']) {
      expect(await referencesFrom(source)).toEqual([{target_id: MARY}, {target_id: TARGET}])
    }
  })

  it('follow a rename into the stored query', async () => {
    await env.typeIntoValue(FENCED)
    await env.repo.awaitProcessors()

    await env.repo.tx(tx => tx.setProperty(MARY, aliasesProp, ['Maria']), options)
    await env.repo.awaitProcessors()

    expect(await env.projected()).toBe(FENCED.replace('[[Mary]]', '[[Maria]]'))
  })
})
