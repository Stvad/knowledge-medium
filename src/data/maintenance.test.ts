// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { staticDataExtensions } from '@/extensions/staticDataExtensions.js'
import { referencesLocalSchema } from '@/plugins/references/localSchema.js'
import {
  applyLocalSchemaContributions,
  resolveLocalSchemaContributions,
} from './localSchema.ts'
import { runAnalyzeInstalledTables } from './maintenance.ts'

describe('runAnalyzeInstalledTables', () => {
  it('analyzes the plugin tables the installed schema declares, not only core ones', async () => {
    // The properties migration roughly triples `block_references`, which core
    // never names: only the references plugin's contribution puts it in the set.
    const executed: string[] = []
    const db = {
      execute: async (sql: string) => { executed.push(sql) },
      getOptional: async () => null,
    }
    await applyLocalSchemaContributions(db, resolveLocalSchemaContributions(staticDataExtensions))
    executed.length = 0

    await runAnalyzeInstalledTables(db)

    const analyzed = executed.filter(sql => sql.startsWith('ANALYZE'))
    for (const {name} of referencesLocalSchema.analyzeTables ?? []) {
      expect(analyzed).toContain(`ANALYZE "main"."${name}"`)
    }
    expect(analyzed).toContain('ANALYZE "main"."blocks"')
  })
})
