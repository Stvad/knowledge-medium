import type {PowerSyncDatabase} from '@powersync/node'
import type {PowerSyncBackendConnector} from '@powersync/common'
import type {KnownAgentCommand} from '@knowledge-medium/agent-cli/protocol'
import type {User} from '@/types'
import type {HeadlessConfig} from '../config'
import {serveDatabase} from '../host'

type Execute = (command: KnownAgentCommand) => Promise<unknown>

/** Serves `db` with a stand-in bridge. `connect` runs where the host connects
 *  sync; `upload` drives the uploader the host installed (writable configs). */
export function startHost(db: PowerSyncDatabase, config: HeadlessConfig, user: User, {
  connect = async () => {}, release = false,
}: {connect?: () => Promise<void>, release?: boolean} = {}) {
  const stop = new AbortController()
  let connector: PowerSyncBackendConnector | undefined
  let register!: (execute: Execute) => void
  const registered = new Promise<Execute>(resolve => { register = resolve })
  const run = serveDatabase(db, config, user, stop.signal,
    async (_db, production) => { connector = production; await connect() },
    async (_config, _user, execute) => {
      register(execute)
      return {close: async () => {}, postEvent: async () => {}}
    }, release)
  const ready = Promise.race([registered, run.then(() => { throw new Error('Host stopped') })])
  const execute = async (command: KnownAgentCommand) => (await ready)(command)
  return {
    ready,
    execute,
    upload: () => {
      if (!connector) throw new Error('The host installed no uploader')
      return connector.uploadData(db)
    },
    stop: () => { stop.abort(); return run },
  }
}
