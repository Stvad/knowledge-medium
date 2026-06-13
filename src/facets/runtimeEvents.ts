export const appRuntimeUpdateEvent = 'app-runtime-update'

export const refreshAppRuntime = () => {
  window.dispatchEvent(new CustomEvent(appRuntimeUpdateEvent, {
    detail: new Date().toISOString(),
  }))
}
