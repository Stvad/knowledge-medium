import {
  AbstractPowerSyncDatabase,
  CrudEntry,
  PowerSyncBackendConnector,
  UpdateType,
} from '@powersync/common'
import { supabase, hasSupabaseAuthConfig } from '@/services/supabase.ts'

const powerSyncUrl = import.meta.env.VITE_POWERSYNC_URL?.trim()

export const hasPowerSyncServiceConfig = Boolean(powerSyncUrl)
export const hasRemoteSyncConfig = hasSupabaseAuthConfig && hasPowerSyncServiceConfig

const assertSupabase = () => {
  if (!supabase) {
    throw new Error('Supabase is not configured')
  }

  return supabase
}

const applyBlockCrudEntry = async (entry: CrudEntry) => {
  const client = assertSupabase()

  if (entry.op === UpdateType.DELETE) {
    const {error} = await client
      .from('blocks')
      .delete()
      .eq('id', entry.id)

    if (error) {
      throw error
    }
    return
  }

  const payload = entry.opData ?? {}

  if (entry.op === UpdateType.PUT) {
    const upsertPayload = {
      ...payload,
      id: entry.id,
    }

    // eslint-disable-next-line no-console
    console.debug('[powersync] PUT', entry.id, Object.keys(upsertPayload))
    const {error} = await client
      .from('blocks')
      .upsert(upsertPayload, {onConflict: 'id'})

    if (error) {
      throw error
    }
    return
  }

  if (entry.op === UpdateType.PATCH) {
    // eslint-disable-next-line no-console
    console.debug('[powersync] PATCH', entry.id, Object.keys(payload))
    const {error} = await client
      .from('blocks')
      .update(payload)
      .eq('id', entry.id)

    if (error) {
      throw error
    }
    return
  }

  throw new Error(`Unsupported CRUD operation: ${entry.op}`)
}

const uploadData = async (database: AbstractPowerSyncDatabase) => {
  while (true) {
    const transaction = await database.getNextCrudTransaction()
    if (!transaction) {
      return
    }

    for (const entry of transaction.crud) {
      if (entry.table !== 'blocks') {
        throw new Error(`Unsupported table in upload queue: ${entry.table}`)
      }

      try {
        await applyBlockCrudEntry(entry)
      } catch (err) {
        // Surface upload errors loudly — silent failures here look like
        // "sync isn't working" with no explanation in the UI.
        // eslint-disable-next-line no-console
        console.error('[powersync] upload failed', {op: entry.op, id: entry.id}, err)
        throw err
      }
    }

    await transaction.complete()
  }
}

export const createPowerSyncConnector = (): PowerSyncBackendConnector => ({
  fetchCredentials: async () => {
    const client = assertSupabase()
    const {data, error} = await client.auth.getSession()

    if (error) {
      throw error
    }

    const accessToken = data.session?.access_token
    if (!accessToken || !powerSyncUrl) {
      return null
    }

    return {
      endpoint: powerSyncUrl,
      token: accessToken,
      expiresAt: data.session?.expires_at
        ? new Date(data.session.expires_at * 1000)
        : undefined,
    }
  },
  uploadData,
})
