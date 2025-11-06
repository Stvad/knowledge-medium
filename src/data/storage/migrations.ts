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

  const currentVersion = await getCurrentVersion(connection)
  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue

    await connection.execute('BEGIN')
    try {
      await connection.executeBatch(migration.sql)
      await connection.execute(
        'INSERT INTO schema_version (version, applied_at) VALUES (?, ?)',
        [migration.version, Math.floor(Date.now() / 1000)]
      )
      await connection.execute('COMMIT')
    } catch (error) {
      await connection.execute('ROLLBACK')
      throw error
    }
  }
}
