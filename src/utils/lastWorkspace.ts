// Persisted "last active workspace id" — used by App.tsx bootstrap to land on
// the user's most recently visited workspace when the URL hash is empty.
//
// Lives in localStorage rather than Repo state so the value survives sign-out
// (so the user lands back where they were when they sign back in) and is
// readable before the Repo / PowerSync are initialized.

const LAST_WORKSPACE_STORAGE_KEY = 'ftm.lastWorkspaceId'

export const rememberWorkspace = (workspaceId: string): void => {
  try {
    window.localStorage.setItem(LAST_WORKSPACE_STORAGE_KEY, workspaceId)
  } catch {
    // ignore (incognito, quota, etc.)
  }
}

export const recallRememberedWorkspace = (): string | undefined => {
  try {
    return window.localStorage.getItem(LAST_WORKSPACE_STORAGE_KEY) ?? undefined
  } catch {
    return undefined
  }
}

export const forgetRememberedWorkspace = (): void => {
  try {
    window.localStorage.removeItem(LAST_WORKSPACE_STORAGE_KEY)
  } catch {
    // ignore
  }
}
