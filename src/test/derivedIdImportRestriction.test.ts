// @vitest-environment node
/**
 * The derived-block-id import restriction, exercised through the REAL config.
 *
 * `src/data/derivedIds.ts` claims to be the only module in `src/` that hashes a
 * block id, and `eslint.config.js` is what makes that true rather than merely
 * observed. But a lint rule guarding a condition the tree does not currently
 * violate is invisible: delete it, or narrow its `files`/`ignores` by accident,
 * and `pnpm run check` stays green — the safeguard is gone and nothing says so
 * until someone hand-rolls a formula and orphans the rows already at the old id.
 *
 * So this drives ESLint over the actual flat config rather than a RuleTester
 * over a rule object: the scoping is the part most likely to break silently,
 * and only the config expresses it.
 */

import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const V5_IMPORT = "import { v5 as uuidv5 } from 'uuid'\nexport const id = uuidv5('key', 'ns')\n"

/** Restriction messages ESLint reports for `code` as if it lived at `filePath`.
 *  The file need not exist — only its path matters, which is the point. */
const restrictionsAt = async (filePath: string, code = V5_IMPORT): Promise<string[]> => {
  const eslint = new ESLint({cwd: process.cwd()})
  const [result] = await eslint.lintText(code, {filePath, warnIgnored: false})
  return (result?.messages ?? [])
    .filter(message => message.ruleId === 'no-restricted-imports')
    .map(message => message.message)
}

// Loading the real flat config pulls in every plugin it references, which is
// most of the cost here: ~1.4s cold and ~0.7s warm for the whole file, standalone.
// 30s is ~20x the cold figure — well past the ~6x the full gate stretches a
// file to under load, and low enough that a genuine hang (a plugin resolving
// off the network, a config that never settles) still reports in half a minute.
describe('uuid v5 is restricted outside @/data/derivedIds', {timeout: 30_000}, () => {
  it('rejects a hand-rolled derivation in ordinary app code', async () => {
    const messages = await restrictionsAt('src/plugins/some-plugin/ids.ts')
    expect(messages).toHaveLength(1)
    // The message has to name the way out, not just say no.
    expect(messages[0]).toMatch(/derivedBlockId/)
    expect(messages[0]).toMatch(/getOrCreateTypedChild|getOrCreateKernelPage/)
  })

  it('rejects it in the data layer too, one file over from the exemption', async () => {
    expect(await restrictionsAt('src/data/somethingElse.ts')).toHaveLength(1)
  })

  /** `src/` is TypeScript by convention, not by rule — `syncedTableSqlRecognizer.js`
   *  is already there — so a `files` glob listing only `.ts`/`.tsx` leaves a
   *  rename as the way around a guard whose whole job is to stop an id formula
   *  being established off the pins.
   *
   *  `.cjs` is deliberately not in this list, and its absence is not an
   *  oversight: the glob does cover it (ESLint reports the file as not
   *  ignored), but a `.cjs` file resolves to `sourceType: 'commonjs'`, where
   *  the derivation would be written `require('uuid')` and there is no import
   *  declaration for `no-restricted-imports` to match. Closing that would take
   *  a different rule, and nothing in `src/` is CommonJS today. */
  it.each(['ids.js', 'ids.jsx', 'ids.mjs', 'ids.mts', 'ids.cts'])(
    'rejects it in a shipped %s too, so a file extension is not a way out',
    async (filename) => {
      expect(await restrictionsAt(`src/plugins/some-plugin/${filename}`)).toHaveLength(1)
    },
  )

  it('allows the one implementation', async () => {
    expect(await restrictionsAt('src/data/derivedIds.ts')).toEqual([])
  })

  it('allows workspaces.ts, whose ids are not blocks', async () => {
    expect(await restrictionsAt('src/data/workspaces.ts')).toEqual([])
  })

  it('allows tests, where hashing independently is what makes the oracle an oracle', async () => {
    expect(await restrictionsAt('src/data/derivedIds.test.ts')).toEqual([])
    expect(await restrictionsAt('src/data/test/somethingElse.ts')).toEqual([])
  })

  it('leaves uuid v4 alone — a random id has nothing to do with this', async () => {
    const v4 = "import { v4 as uuidv4 } from 'uuid'\nexport const id = uuidv4()\n"
    expect(await restrictionsAt('src/plugins/some-plugin/ids.ts', v4)).toEqual([])
  })
})
