// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { staticDataExtensions } from '@/extensions/staticDataExtensions.js'
import { referencesLocalSchema } from '@/plugins/references/localSchema.js'
import {
  applyLocalSchemaContributions,
  resolveLocalSchemaContributions,
} from './localSchema.ts'
import { oweAnalyzeInstalledTables, runAnalyzeInstalledTables } from './maintenance.ts'

// The properties migration roughly triples `block_references`, which core
// never names: only the references plugin's contribution puts it in the set.
describe('the installed-table ANALYZE helpers', () => {
  const pluginTables = (referencesLocalSchema.analyzeTables ?? []).map(table => table.name)
  const installed = async () => {
    const executed: Array<{sql: string; params: unknown[]}> = []
    const db = {
      execute: async (sql: string, params: unknown[] = []) => { executed.push({sql, params}) },
      getOptional: async () => null,
    }
    await applyLocalSchemaContributions(db, resolveLocalSchemaContributions(staticDataExtensions))
    executed.length = 0
    return {db, executed}
  }

  it('analyze the plugin tables the installed schema declares, not only core ones', async () => {
    const {db, executed} = await installed()

    await runAnalyzeInstalledTables(db)

    const analyzed = executed.map(({sql}) => sql).filter(sql => sql.startsWith('ANALYZE'))
    expect(pluginTables).not.toHaveLength(0)
    for (const name of pluginTables) expect(analyzed).toContain(`ANALYZE "main"."${name}"`)
    expect(analyzed).toContain('ANALYZE "main"."blocks"')
  })

  it('owe the same tables', async () => {
    const {db, executed} = await installed()

    await oweAnalyzeInstalledTables(db)

    const owed = executed.flatMap(({params}) => params)
    for (const name of [...pluginTables, 'blocks']) expect(owed).toContain(`analyze_owed:${name}`)
  })
})
