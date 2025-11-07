import type { AsyncDatabaseConnection } from '@powersync/web'

interface Migration {
  version: number
  sql: string
}

const migrations: Migration[] = Object.entries(
  import.meta.glob('./schema/*.sql', { eager: true, as: 'raw' })
).map(([path, sql]) => {
  const match = /(\d+)_/.exec(path)
  if (!match) {
    throw new Error(`Migration filename must start with version number: ${path}`)
  }
  return {
    version: Number.parseInt(match[1], 10),
    sql: sql as string,
  }
}).sort((a, b) => a.version - b.version)

async function ensureSchemaVersionTable(connection: AsyncDatabaseConnection): Promise<void> {
  const createStatement = `
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `
  await connection.execute(createStatement)
}

async function getCurrentVersion(connection: AsyncDatabaseConnection): Promise<number> {
  const result = await connection.execute(
    'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1'
  )
  const rows = result.rows?._array ?? []
  if (!rows.length) return 0
  const row = rows[0] as { version: number }
  return row?.version ?? 0
}

export async function runMigrations(connection: AsyncDatabaseConnection): Promise<void> {
  await ensureSchemaVersionTable(connection)

  let currentVersion = await getCurrentVersion(connection)
  const existingTablesResult = await connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
  const existingTables = new Set((existingTablesResult.rows?._array ?? []).map((row: any) => row.name as string))

  if (currentVersion > 0 && !existingTables.has('blocks')) {
    console.warn(
      'runMigrations: schema_version indicates version',
      currentVersion,
      'but blocks table missing; resetting schema_version'
    )
    currentVersion = 0
    await connection.execute('DELETE FROM schema_version')
  }

  console.info('runMigrations: current version', currentVersion, 'pending', migrations.map((m) => m.version))
  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue

    try {
      console.info('runMigrations: applying migration', migration.version)
      await connection.executeBatch(migration.sql, [[]])
      await connection.execute(
        'INSERT INTO schema_version (version, applied_at) VALUES (?, ?)',
        [migration.version, Math.floor(Date.now() / 1000)]
      )
    } catch (error) {
      console.error('runMigrations: migration failed', migration.version, error)
      throw error
    }
  }

  const tablesResult = await connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
  console.info('runMigrations: tables', tablesResult.rows?._array)
}
