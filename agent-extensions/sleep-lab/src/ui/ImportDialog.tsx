/** Reads pasted or uploaded watch-export files, runs the pure parser, and —
 *  when it found anything — writes the sessions through the km write path,
 *  all from one submit. `importSessions` names two different things in this
 *  extension: the pure parser (`../import/index`) and the km writer
 *  (`../km/nights`), so both are aliased on import here.
 */
import {useState} from 'react'

import type {DialogContextProps} from '@/utils/dialogs.js'
import type {Repo} from '@/data/repo.js'

import {importSessions as parseSessions, SAMSUNG_SLEEP_FILE_HINT, type ImportFile} from '../import/index'
import {importSessions as writeSessions, type ImportReport} from '../km/nights'

export interface ImportDialogProps {
  repo: Repo
  workspaceId: string
}

interface Outcome {
  warnings: readonly string[]
  sessionCount: number
  report?: ImportReport
  error?: string
}

const readFiles = async (fileList: FileList | null): Promise<ImportFile[]> => {
  if (!fileList) return []
  // The path inside a picked folder, when there is one: the Samsung export's
  // HRV lives in `jsons/com.samsung.health.hrv/…`, and the parser tells the
  // files apart by their dotted path segments.
  return Promise.all(Array.from(fileList).map(async file => ({
    name: file.webkitRelativePath || file.name,
    text: await file.text(),
  })))
}

export const ImportDialog = ({repo, workspaceId, resolve, cancel}: DialogContextProps<void> & ImportDialogProps) => {
  const [pasted, setPasted] = useState('')
  const [fileList, setFileList] = useState<FileList | null>(null)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  const hasInput = pasted.trim() !== '' || (fileList?.length ?? 0) > 0

  const runImport = async () => {
    setBusy(true)
    setOutcome(null)
    try {
      const uploaded = await readFiles(fileList)
      const files = pasted.trim() ? [...uploaded, {name: 'pasted.json', text: pasted}] : uploaded
      const {sessions, warnings} = parseSessions(files)
      if (sessions.length === 0) {
        setOutcome({warnings, sessionCount: 0})
        return
      }
      const report = await writeSessions(repo, workspaceId, sessions)
      setOutcome({warnings, sessionCount: sessions.length, report})
    } catch (error) {
      console.error('[sleep-lab] could not import watch data', error)
      setOutcome({warnings: [], sessionCount: 0, error: 'Could not import — nothing was saved.'})
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex max-w-md flex-col gap-4 p-4">
      <div>
        <h2 className="text-base font-semibold">Import watch data</h2>
        <p className="mt-1 text-xs text-muted-foreground">{SAMSUNG_SLEEP_FILE_HINT}</p>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        Export folder (Samsung Health)
        {/* A folder, so the HRV binning JSONs come with the CSVs. The attribute
            is non-standard and not in React's typings, hence the spread. */}
        <input
          type="file"
          multiple
          className="text-sm"
          {...{webkitdirectory: ''}}
          onChange={event => setFileList(event.currentTarget.files)}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Or individual files
        <input
          type="file"
          multiple
          accept=".json,.csv"
          className="text-sm"
          onChange={event => setFileList(event.currentTarget.files)}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Or paste a webhook JSON payload
        <textarea
          rows={6}
          className="rounded border border-border bg-transparent px-2 py-1 font-mono text-xs"
          value={pasted}
          onChange={event => setPasted(event.currentTarget.value)}
        />
      </label>

      {outcome ? (
        <div className="flex flex-col gap-1 rounded border border-border bg-muted/40 p-2 text-xs">
          {outcome.error ? <span className="text-destructive">{outcome.error}</span> : null}
          {outcome.warnings.map(warning => (
            <span key={warning} className="text-amber-700 dark:text-amber-400">{warning}</span>
          ))}
          {outcome.report ? (
            <>
              <span>
                {`${outcome.sessionCount} session${outcome.sessionCount === 1 ? '' : 's'} across `
                  + `${outcome.report.nights} night${outcome.report.nights === 1 ? '' : 's'} — `
                  + `${outcome.report.created} created, ${outcome.report.updated} updated.`}
              </span>
              {outcome.report.failed.map(failure => (
                <span key={failure.date} className="text-destructive">{`${failure.date}: ${failure.error}`}</span>
              ))}
            </>
          ) : outcome.sessionCount === 0 && !outcome.error ? (
            <span>No sessions found in what was given.</span>
          ) : null}
        </div>
      ) : null}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="rounded border border-border px-3 py-1.5 text-sm hover:bg-muted"
          onClick={() => (outcome?.report ? resolve() : cancel())}
        >{outcome?.report ? 'Done' : 'Cancel'}</button>
        <button
          type="button"
          disabled={busy || !hasInput}
          className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          onClick={() => void runImport()}
        >{busy ? 'Importing…' : 'Import'}</button>
      </div>
    </div>
  )
}
ImportDialog.displayName = 'ImportDialog'
