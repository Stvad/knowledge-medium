import { describe, expect, it } from 'vitest'

import {
  applyMigration,
  checkFile,
  extractCreateTableColumns,
  extractReturnsTableColumns,
  extractTsFields,
  parseTag,
} from './check-rpc-projections'

describe('parseTag', () => {
  it('parses a bare table', () => {
    expect(parseTag('// @projects: workspace_members')).toEqual({
      table: 'workspace_members',
      extras: [],
    })
  })

  it('parses extras', () => {
    expect(parseTag('-- @projects: workspace_invitations + workspace_name')).toEqual({
      table: 'workspace_invitations',
      extras: ['workspace_name'],
    })
  })

  it('strips trailing ? from extras', () => {
    expect(parseTag('// @projects: workspace_invitations + workspace_name?')).toEqual({
      table: 'workspace_invitations',
      extras: ['workspace_name'],
    })
  })

  it('returns null on no marker', () => {
    expect(parseTag('// just a comment')).toBeNull()
  })
})

describe('extractCreateTableColumns', () => {
  it('skips table-level CONSTRAINT and CHECK rows', () => {
    const body = `
      "id" "text" NOT NULL,
      "workspace_id" "text" NOT NULL,
      "role" "text" NOT NULL,
      CONSTRAINT "workspace_members_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'editor'::"text"])))
    `
    expect(extractCreateTableColumns(body)).toEqual(['id', 'workspace_id', 'role'])
  })

  it('handles unquoted identifiers and inline PRIMARY KEY', () => {
    const body = `
      id text PRIMARY KEY NOT NULL,
      block_id text NOT NULL,
      created_at bigint
    `
    expect(extractCreateTableColumns(body)).toEqual(['id', 'block_id', 'created_at'])
  })
})

describe('applyMigration', () => {
  it('builds column sets from CREATE TABLE', () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS "public"."workspaces" (
        "id" "text" NOT NULL,
        "name" "text" NOT NULL,
        "owner_user_id" "text" NOT NULL
      );
    `
    const sot = new Map<string, string[]>()
    applyMigration(sql, sot)
    expect(sot.get('workspaces')).toEqual(['id', 'name', 'owner_user_id'])
  })

  it('applies ALTER TABLE ADD COLUMN after CREATE TABLE', () => {
    const sql = `
      CREATE TABLE public.workspaces (
        id text NOT NULL,
        name text NOT NULL
      );
      ALTER TABLE public.workspaces ADD COLUMN encryption_mode TEXT;
    `
    const sot = new Map<string, string[]>()
    applyMigration(sql, sot)
    expect(sot.get('workspaces')).toEqual(['id', 'name', 'encryption_mode'])
  })

  it('applies ALTER TABLE DROP COLUMN', () => {
    const sql = `
      CREATE TABLE public.foo (
        a text,
        b text,
        c text
      );
      ALTER TABLE public.foo DROP COLUMN b;
    `
    const sot = new Map<string, string[]>()
    applyMigration(sql, sot)
    expect(sot.get('foo')).toEqual(['a', 'c'])
  })

  it('does not duplicate when ADD COLUMN repeats an existing column', () => {
    const sql = `
      CREATE TABLE public.foo (a text);
      ALTER TABLE public.foo ADD COLUMN IF NOT EXISTS a text;
    `
    const sot = new Map<string, string[]>()
    applyMigration(sql, sot)
    expect(sot.get('foo')).toEqual(['a'])
  })
})

describe('extractReturnsTableColumns', () => {
  it('extracts a multi-line RETURNS TABLE column list', () => {
    const sql = `
      CREATE FUNCTION foo() RETURNS TABLE(
        "id" "text",
        "workspace_id" "text",
        "create_time" bigint
      ) AS $$ select 1 $$;
    `
    expect(extractReturnsTableColumns(sql, 0)).toEqual([
      'id',
      'workspace_id',
      'create_time',
    ])
  })

  it('handles nested parens inside column types', () => {
    // Postgres allows e.g. NUMERIC(10, 2). The split-on-top-level-commas
    // logic should not break the column list when a type uses parens.
    const sql = `RETURNS TABLE("id" "text", "amount" NUMERIC(10, 2), "create_time" bigint)`
    expect(extractReturnsTableColumns(sql, 0)).toEqual(['id', 'amount', 'create_time'])
  })
})

describe('extractTsFields', () => {
  it('returns field names from a flat interface body', () => {
    const text = `interface Row {
  id: string
  workspace_id: string
  create_time: number | string
}`
    const open = text.indexOf('{')
    expect(extractTsFields(text, open)).toEqual(['id', 'workspace_id', 'create_time'])
  })

  it('tolerates optional fields and skips comments', () => {
    const text = `type Row = {
  // a comment
  id: string
  workspace_name?: string
}`
    const open = text.indexOf('{')
    expect(extractTsFields(text, open)).toEqual(['id', 'workspace_name'])
  })
})

describe('checkFile integration', () => {
  // Fixture: one CREATE TABLE migration + one RETURNS TABLE that
  // accidentally omits a column.
  const sotSql = `
    CREATE TABLE public.things (
      "id" text NOT NULL,
      "name" text NOT NULL,
      "secret" text
    );
  `
  const projectionSql = `
    -- @projects: things
    CREATE OR REPLACE FUNCTION list_things() RETURNS TABLE("id" text, "name" text)
    AS $$ select id, name from public.things $$;
  `
  const sot = new Map<string, string[]>()
  applyMigration(sotSql, sot)

  it('flags a missing column in a tagged RETURNS TABLE', () => {
    const findings = checkFile(
      '/fake/things.sql',
      projectionSql,
      /--\s*@projects:[^\r\n]+/g,
      extractReturnsTableColumns,
      'sql',
      sot,
    )
    expect(findings).toHaveLength(1)
    expect(findings[0].missing).toEqual(['secret'])
    expect(findings[0].unexpected).toEqual([])
  })

  it('accepts a projection whose extras cover the diff', () => {
    const fullProjection = `
      -- @projects: things + email
      CREATE OR REPLACE FUNCTION list_things_with_email()
        RETURNS TABLE("id" text, "name" text, "secret" text, "email" text)
      AS $$ select 1 $$;
    `
    const findings = checkFile(
      '/fake/full.sql',
      fullProjection,
      /--\s*@projects:[^\r\n]+/g,
      extractReturnsTableColumns,
      'sql',
      sot,
    )
    expect(findings).toEqual([])
  })

  it('flags an unknown table', () => {
    const findings = checkFile(
      '/fake/unknown.sql',
      `-- @projects: ghosts\nCREATE FUNCTION g() RETURNS TABLE("id" text) AS $$ select 1 $$;`,
      /--\s*@projects:[^\r\n]+/g,
      extractReturnsTableColumns,
      'sql',
      sot,
    )
    expect(findings).toHaveLength(1)
    expect(findings[0].note).toMatch(/unknown table "ghosts"/)
  })
})
