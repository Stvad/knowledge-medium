// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  CREATE_BLOCKS_SYNCED_TABLE_SQL,
  CREATE_BLOCKS_TABLE_SQL,
  CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL,
} from '@/data/blockSchema'
import {
  ANALYZE_ARMING_PROBES,
  CLIENT_SCHEMA_STATEMENTS,
} from '@/data/internals/clientSchema'
import { syncedWriteTarget } from '@/data/syncedTableWriteGuard'
import { staticDataExtensions } from '@/extensions/staticDataExtensions.js'
import {
  resolveAnalyzeArmingProbes,
  resolveLocalSchemaContributions,
} from './localSchema.ts'

// The arming probes are the one part of the ANALYZE design that fails SILENTLY:
// a probe whose predicate matches no index plans to a SCAN, which does not arm,
// and the only symptom is a table that quietly stops being re-analyzed on the
// drift axis until some join order inverts. So the whole resolved set — core
// plus every installed contribution — is checked against a real schema here
// rather than by eye at each declaration.
describe('resolveAnalyzeArmingProbes', () => {
  const contributions = resolveLocalSchemaContributions(staticDataExtensions)
  const probes = resolveAnalyzeArmingProbes(contributions)
  let db: DatabaseSync

  beforeAll(() => {
    db = new DatabaseSync(':memory:')
    // `blocks` first: contributed statements index and trigger off it.
    db.exec(CREATE_BLOCKS_TABLE_SQL)
    db.exec(CREATE_BLOCKS_SYNCED_TABLE_SQL)
    db.exec(CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL)
    for (const statement of CLIENT_SCHEMA_STATEMENTS) db.exec(statement)
    for (const contribution of contributions) {
      for (const statement of contribution.statements ?? []) db.exec(statement)
    }
  })
  afterAll(() => { db.close() })

  const planOf = (probe: string) =>
    db.prepare(`EXPLAIN QUERY PLAN ${probe}`).all()
      .map(row => String((row as {detail?: unknown}).detail)).join(' | ')

  it('arms every table that needs it, and each probe plans to an index SEARCH', () => {
    // One assertion, deliberately, because the two halves prop each other up.
    // Reading the table name out of the PLAN rather than out of the SQL is what
    // makes it a real check: a probe SQLite decided to answer with a SCAN
    // contributes no `SEARCH <table>` and drops out of this set, so a silently
    // inert probe reads the same as a missing one.
    //
    // Includes `block_references`, which core does NOT name — it is here only
    // because the references plugin contributes it. Drop that contribution and
    // this set loses a member.
    const armed = new Set(
      probes.flatMap(probe => [...planOf(probe).matchAll(/SEARCH (\w+)/g)].map(m => m[1])),
    )
    expect(armed).toEqual(new Set([
      'blocks',
      'block_types',
      'block_aliases',
      'block_references',
    ]))
  })

  it('carries the core probes as well as the contributed ones', () => {
    // `resolveAnalyzeArmingProbes` is the only caller-facing composition point;
    // a bug that returned contributions ALONE would still pass the plan check
    // above for every table a plugin happens to own.
    expect(probes).toEqual(expect.arrayContaining([...ANALYZE_ARMING_PROBES]))
  })

  it('are reads, so the synced-table write guard passes them through', () => {
    // The probes run through repoProvider's guarded `execute`. One written as a
    // write to `blocks` would reject there and take out the ANALYZE on every
    // single boot — in production only, since the guard wraps only that shim.
    // Contributed probes are the reason this now covers the resolved set: a
    // plugin author has no way to know the guard is downstream of them.
    for (const probe of probes) {
      expect(syncedWriteTarget(`EXPLAIN QUERY PLAN ${probe}`)).toBeNull()
    }
  })

  it('takes no parameters, because the db surface that runs them binds none', () => {
    // `LocalSchemaDb` declares a params-less `execute`, so a bound `?` would
    // silently bind NULL. Harmless for a plan, but the shape is the contract.
    for (const probe of probes) expect(probe).not.toContain('?')
  })
})
