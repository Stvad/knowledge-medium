/** A non-browser host installs its device storage before the auth client is constructed. */
export let authStorage: Storage | undefined

export const setAuthStorage = (storage: Storage): void => {
  authStorage = storage
}
