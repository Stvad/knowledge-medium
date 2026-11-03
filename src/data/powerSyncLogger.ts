import { LogLevels, createConsoleLogger } from '@powersync/web'

/** The logger every PowerSync database and open factory here gets. Warn level,
 *  close to the 1.x SDK's silent default: the sync client logs each checkpoint
 *  it holds back for local writes at info, which is most edits. */
export const powerSyncLogger = createConsoleLogger({minLevel: LogLevels.warn})
